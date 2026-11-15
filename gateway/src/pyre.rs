//! The subset of Python's `re` that the ASR replacement rules use, always case-insensitive, for `re.sub`.
//! CI builds offline from a seeded crate cache, so this stands in for the `regex` crate (which also lacks lookahead).
//!
//! Supported: literals and escapes, `.`, classes (`[a-z\d]`, `[^...]`), `\d \D \w \W \s \S \b \B \A \Z ^ $`, groups
//! (`(...)`, `(?:...)`, `(?P<name>...)`), lookahead (`(?=...)`, `(?!...)`), `|`, and `* + ? {m} {m,} {m,n}`, lazy too.
//! Anything else (lookbehind, backreferences in the pattern, other flags) is a compile error, so the rule is skipped.
//! A backtracking matcher with a step budget: a pattern that would blow up just doesn't match.

const MAX_REPEAT: u32 = 1000;
const STEP_BUDGET: usize = 200_000;
/// Each backtracking point is a recursion; this bounds the stack (a tokio worker has 2 MB).
const MAX_DEPTH: usize = 2_000;

#[derive(Debug)]
pub struct Regex {
    prog: Vec<Inst>,
    groups: usize,
    names: Vec<(String, usize)>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Assertion {
    Start,
    End,
    TextEnd,
    WordBoundary,
    NotWordBoundary,
}

#[derive(Debug, Clone)]
enum ClassItem {
    Range(char, char),
    Digit(bool),
    Word(bool),
    Space(bool),
}

#[derive(Debug, Clone)]
struct Class {
    negated: bool,
    items: Vec<ClassItem>,
}

#[derive(Debug, Clone)]
enum Node {
    Char(char),
    Any,
    Class(Class),
    Assert(Assertion),
    Group(Box<Node>, Option<usize>),
    Concat(Vec<Node>),
    Alt(Vec<Node>),
    Repeat(Box<Node>, u32, Option<u32>, bool),
    Look(Box<Node>, bool),
}

#[derive(Debug)]
enum Inst {
    Char(char),
    Any,
    Class(Class),
    Assert(Assertion),
    /// Try the first target, then the second.
    Split(usize, usize),
    Jmp(usize),
    Save(usize),
    /// A lookahead: its own program, and whether it is negated.
    Look(Vec<Inst>, bool),
    Match,
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn lower(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

fn upper(c: char) -> char {
    c.to_uppercase().next().unwrap_or(c)
}

impl ClassItem {
    fn matches(&self, c: char) -> bool {
        match *self {
            ClassItem::Range(a, b) => [c, lower(c), upper(c)].iter().any(|x| (a..=b).contains(x)),
            ClassItem::Digit(neg) => c.is_numeric() != neg,
            ClassItem::Word(neg) => is_word(c) != neg,
            ClassItem::Space(neg) => c.is_whitespace() != neg,
        }
    }
}

impl Class {
    fn matches(&self, c: char) -> bool {
        self.items.iter().any(|i| i.matches(c)) != self.negated
    }
}

struct Parser<'a> {
    s: &'a [char],
    i: usize,
    groups: usize,
    names: Vec<(String, usize)>,
}

type Res<T> = Result<T, &'static str>;

impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        self.s.get(self.i).copied()
    }
    fn eat(&mut self, c: char) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn next(&mut self) -> Res<char> {
        let c = self.peek().ok_or("unexpected end")?;
        self.i += 1;
        Ok(c)
    }

    fn alt(&mut self) -> Res<Node> {
        let mut branches = vec![self.concat()?];
        while self.eat('|') {
            branches.push(self.concat()?);
        }
        Ok(if branches.len() == 1 { branches.pop().unwrap() } else { Node::Alt(branches) })
    }

    fn concat(&mut self) -> Res<Node> {
        let mut items = Vec::new();
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' {
                break;
            }
            let atom = self.atom()?;
            items.push(self.quantified(atom)?);
        }
        Ok(Node::Concat(items))
    }

    fn quantified(&mut self, atom: Node) -> Res<Node> {
        let start = self.i;
        let (min, max) = match self.peek() {
            Some('*') => (0, None),
            Some('+') => (1, None),
            Some('?') => (0, Some(1)),
            Some('{') => match self.braces() {
                Some(b) => b,
                None => {
                    self.i = start;
                    return Ok(atom);
                }
            },
            _ => return Ok(atom),
        };
        if self.i == start {
            self.i += 1;
        }
        if matches!(atom, Node::Assert(_) | Node::Look(..)) {
            return Err("nothing to repeat");
        }
        if max.is_some_and(|m| m < min) || min > MAX_REPEAT || max.is_some_and(|m| m > MAX_REPEAT) {
            return Err("bad repeat");
        }
        let greedy = !self.eat('?');
        if matches!(self.peek(), Some('*' | '+' | '?' | '{')) && self.braces_ahead() {
            return Err("multiple repeat");
        }
        Ok(Node::Repeat(Box::new(atom), min, max, greedy))
    }

    fn braces_ahead(&self) -> bool {
        self.peek() != Some('{') || Parser { s: self.s, i: self.i, groups: 0, names: vec![] }.braces().is_some()
    }

    /// `{m}`, `{m,}`, `{,n}`, `{m,n}`; anything else is a literal `{`, as in Python.
    fn braces(&mut self) -> Option<(u32, Option<u32>)> {
        let rest: String = self.s[self.i..].iter().take_while(|c| **c != '}').collect();
        if self.s.get(self.i + rest.chars().count()) != Some(&'}') {
            return None;
        }
        let inner = rest.strip_prefix('{')?;
        let num = |t: &str| -> Option<Option<u32>> {
            if t.is_empty() {
                Some(None)
            } else if t.chars().all(|c| c.is_ascii_digit()) {
                t.parse().ok().map(Some)
            } else {
                None
            }
        };
        let (min, max) = match inner.split_once(',') {
            None => {
                let n = num(inner)??;
                (n, Some(n))
            }
            Some((a, b)) => (num(a)?.unwrap_or(0), num(b)?),
        };
        self.i += rest.chars().count() + 1;
        Some((min, max))
    }

    fn atom(&mut self) -> Res<Node> {
        Ok(match self.next()? {
            '.' => Node::Any,
            '^' => Node::Assert(Assertion::Start),
            '$' => Node::Assert(Assertion::End),
            '[' => Node::Class(self.class()?),
            '(' => self.group()?,
            '\\' => self.escape(false)?,
            '*' | '+' | '?' => return Err("nothing to repeat"),
            c => Node::Char(c),
        })
    }

    fn group(&mut self) -> Res<Node> {
        let node = if self.eat('?') {
            match self.next()? {
                ':' => Node::Group(Box::new(self.alt()?), None),
                '=' => Node::Look(Box::new(self.alt()?), false),
                '!' => Node::Look(Box::new(self.alt()?), true),
                'P' if self.eat('<') => {
                    let mut name = String::new();
                    loop {
                        match self.next()? {
                            '>' => break,
                            c if is_word(c) => name.push(c),
                            _ => return Err("bad group name"),
                        }
                    }
                    self.groups += 1;
                    let idx = self.groups;
                    self.names.push((name, idx));
                    Node::Group(Box::new(self.alt()?), Some(idx))
                }
                'i' if self.eat(')') => return Ok(Node::Concat(vec![])),
                _ => return Err("unsupported group"),
            }
        } else {
            self.groups += 1;
            let idx = self.groups;
            Node::Group(Box::new(self.alt()?), Some(idx))
        };
        if !self.eat(')') {
            return Err("missing )");
        }
        Ok(node)
    }

    fn escape(&mut self, in_class: bool) -> Res<Node> {
        let c = self.next()?;
        let class = |item| Node::Class(Class { negated: false, items: vec![item] });
        Ok(match c {
            'd' => class(ClassItem::Digit(false)),
            'D' => class(ClassItem::Digit(true)),
            'w' => class(ClassItem::Word(false)),
            'W' => class(ClassItem::Word(true)),
            's' => class(ClassItem::Space(false)),
            'S' => class(ClassItem::Space(true)),
            'b' if in_class => Node::Char('\u{8}'),
            'b' => Node::Assert(Assertion::WordBoundary),
            'B' if !in_class => Node::Assert(Assertion::NotWordBoundary),
            'A' if !in_class => Node::Assert(Assertion::Start),
            'Z' if !in_class => Node::Assert(Assertion::TextEnd),
            'n' => Node::Char('\n'),
            't' => Node::Char('\t'),
            'r' => Node::Char('\r'),
            'f' => Node::Char('\u{c}'),
            'v' => Node::Char('\u{b}'),
            'a' => Node::Char('\u{7}'),
            'x' => Node::Char(self.hex(2)?),
            'u' => Node::Char(self.hex(4)?),
            c if c.is_ascii_alphanumeric() => return Err("unsupported escape"),
            c => Node::Char(c),
        })
    }

    fn hex(&mut self, n: usize) -> Res<char> {
        let digits: String = (0..n).map(|_| self.next()).collect::<Res<_>>()?;
        u32::from_str_radix(&digits, 16).ok().and_then(char::from_u32).ok_or("bad hex escape")
    }

    fn class(&mut self) -> Res<Class> {
        let negated = self.eat('^');
        let mut items = Vec::new();
        let mut first = true;
        loop {
            let c = self.next()?;
            if c == ']' && !first {
                break;
            }
            first = false;
            let lo = if c == '\\' {
                match self.escape(true)? {
                    Node::Char(c) => c,
                    Node::Class(cl) => {
                        items.extend(cl.items);
                        continue;
                    }
                    _ => return Err("bad class escape"),
                }
            } else {
                c
            };
            if self.peek() == Some('-') && self.s.get(self.i + 1).is_some_and(|c| *c != ']') {
                self.i += 1;
                let hi = match self.next()? {
                    '\\' => match self.escape(true)? {
                        Node::Char(c) => c,
                        _ => return Err("bad class range"),
                    },
                    c => c,
                };
                if hi < lo {
                    return Err("bad class range");
                }
                items.push(ClassItem::Range(lo, hi));
            } else {
                items.push(ClassItem::Range(lo, lo));
            }
        }
        Ok(Class { negated, items })
    }
}

fn compile(node: &Node, out: &mut Vec<Inst>) {
    match node {
        Node::Char(c) => out.push(Inst::Char(*c)),
        Node::Any => out.push(Inst::Any),
        Node::Class(c) => out.push(Inst::Class(c.clone())),
        Node::Assert(a) => out.push(Inst::Assert(*a)),
        Node::Group(inner, idx) => {
            if let Some(i) = idx {
                out.push(Inst::Save(2 * i));
            }
            compile(inner, out);
            if let Some(i) = idx {
                out.push(Inst::Save(2 * i + 1));
            }
        }
        Node::Concat(items) => items.iter().for_each(|n| compile(n, out)),
        Node::Alt(branches) => {
            let mut jumps = Vec::new();
            for (k, b) in branches.iter().enumerate() {
                if k + 1 < branches.len() {
                    let split = out.len();
                    out.push(Inst::Split(split + 1, 0));
                    compile(b, out);
                    jumps.push(out.len());
                    out.push(Inst::Jmp(0));
                    let next = out.len();
                    out[split] = Inst::Split(split + 1, next);
                } else {
                    compile(b, out);
                }
            }
            let end = out.len();
            for j in jumps {
                out[j] = Inst::Jmp(end);
            }
        }
        Node::Repeat(inner, min, max, greedy) => {
            let split = |body: usize, exit: usize| if *greedy { Inst::Split(body, exit) } else { Inst::Split(exit, body) };
            for _ in 0..*min {
                compile(inner, out);
            }
            match max {
                None => {
                    let top = out.len();
                    out.push(Inst::Jmp(0));
                    compile(inner, out);
                    out.push(Inst::Jmp(top));
                    let exit = out.len();
                    out[top] = split(top + 1, exit);
                }
                Some(max) => {
                    let mut splits = Vec::new();
                    for _ in *min..*max {
                        splits.push(out.len());
                        out.push(Inst::Jmp(0));
                        compile(inner, out);
                    }
                    let exit = out.len();
                    for s in splits {
                        out[s] = split(s + 1, exit);
                    }
                }
            }
        }
        Node::Look(inner, negated) => {
            let mut sub = Vec::new();
            compile(inner, &mut sub);
            sub.push(Inst::Match);
            out.push(Inst::Look(sub, *negated));
        }
    }
}

struct Run<'a> {
    text: &'a [char],
    steps: usize,
    depth: usize,
}

impl Run<'_> {
    fn assert(&self, a: Assertion, sp: usize) -> bool {
        let n = self.text.len();
        let word_before = sp > 0 && is_word(self.text[sp - 1]);
        let word_after = sp < n && is_word(self.text[sp]);
        match a {
            Assertion::Start => sp == 0,
            Assertion::End => sp == n || (sp + 1 == n && self.text[sp] == '\n'),
            Assertion::TextEnd => sp == n,
            Assertion::WordBoundary => word_before != word_after,
            Assertion::NotWordBoundary => word_before == word_after,
        }
    }

    /// Whether `prog` matches from `pc` at `sp`; on a match `caps` holds the groups. None: out of budget.
    fn exec(&mut self, prog: &[Inst], pc: usize, sp: usize, caps: &mut Vec<Option<usize>>) -> Option<bool> {
        if self.depth >= MAX_DEPTH {
            return None;
        }
        self.depth += 1;
        let found = self.step(prog, pc, sp, caps);
        self.depth -= 1;
        found
    }

    fn step(&mut self, prog: &[Inst], mut pc: usize, mut sp: usize, caps: &mut Vec<Option<usize>>) -> Option<bool> {
        loop {
            self.steps += 1;
            if self.steps > STEP_BUDGET {
                return None;
            }
            match &prog[pc] {
                Inst::Match => {
                    caps[1] = Some(sp);
                    return Some(true);
                }
                Inst::Char(c) => match self.text.get(sp) {
                    Some(t) if t == c || lower(*t) == lower(*c) => (pc, sp) = (pc + 1, sp + 1),
                    _ => return Some(false),
                },
                Inst::Any => match self.text.get(sp) {
                    Some(t) if *t != '\n' => (pc, sp) = (pc + 1, sp + 1),
                    _ => return Some(false),
                },
                Inst::Class(cl) => match self.text.get(sp) {
                    Some(t) if cl.matches(*t) => (pc, sp) = (pc + 1, sp + 1),
                    _ => return Some(false),
                },
                Inst::Assert(a) => {
                    if !self.assert(*a, sp) {
                        return Some(false);
                    }
                    pc += 1;
                }
                Inst::Jmp(to) => pc = *to,
                Inst::Split(a, b) => {
                    let saved = caps.clone();
                    if self.exec(prog, *a, sp, caps)? {
                        return Some(true);
                    }
                    *caps = saved;
                    pc = *b;
                }
                Inst::Save(slot) => {
                    let old = caps[*slot];
                    caps[*slot] = Some(sp);
                    if self.exec(prog, pc + 1, sp, caps)? {
                        return Some(true);
                    }
                    caps[*slot] = old;
                    return Some(false);
                }
                Inst::Look(sub, negated) => {
                    let mut inner = caps.clone();
                    let found = self.exec(sub, 0, sp, &mut inner)?;
                    if found == *negated {
                        return Some(false);
                    }
                    if found {
                        // Groups set inside a positive lookahead stay set, as in Python; its end is not the match's.
                        inner[1] = caps[1];
                        *caps = inner;
                    }
                    pc += 1;
                }
            }
        }
    }
}

impl Regex {
    pub fn new(pattern: &str) -> Result<Self, &'static str> {
        let chars: Vec<char> = pattern.chars().collect();
        let mut p = Parser { s: &chars, i: 0, groups: 0, names: Vec::new() };
        let node = p.alt()?;
        if p.i != chars.len() {
            return Err("unbalanced )");
        }
        let mut prog = Vec::new();
        compile(&node, &mut prog);
        prog.push(Inst::Match);
        Ok(Self { prog, groups: p.groups, names: p.names })
    }

    /// `literal` as a whole word or phrase: no word character may touch either end, where that end is one.
    pub fn whole_word(literal: &str) -> Self {
        let chars: Vec<char> = literal.chars().collect();
        let mut prog = Vec::new();
        if chars.first().is_some_and(|c| is_word(*c)) {
            prog.push(Inst::Assert(Assertion::WordBoundary));
        }
        prog.extend(chars.iter().map(|c| Inst::Char(*c)));
        if chars.last().is_some_and(|c| is_word(*c)) {
            prog.push(Inst::Assert(Assertion::WordBoundary));
        }
        prog.push(Inst::Match);
        Self { prog, groups: 0, names: Vec::new() }
    }

    /// The leftmost match at or after `from`, as capture slots (char offsets); slot 0..1 is the whole match.
    fn find_at(&self, text: &[char], from: usize) -> Option<Vec<Option<usize>>> {
        let mut run = Run { text, steps: 0, depth: 0 };
        for start in from..=text.len() {
            let mut caps = vec![None; 2 * (self.groups + 1)];
            caps[0] = Some(start);
            match run.exec(&self.prog, 0, start, &mut caps) {
                Some(true) => return Some(caps),
                Some(false) => {}
                None => return None,
            }
        }
        None
    }

    /// `re.sub(pattern, template, text, flags=re.I)`. With `literal`, the replacement is used as is.
    pub fn replace_all(&self, text: &str, replacement: &str, literal: bool) -> String {
        let chars: Vec<char> = text.chars().collect();
        let mut out = String::new();
        let mut pos = 0;
        while pos <= chars.len() {
            let Some(caps) = self.find_at(&chars, pos) else { break };
            let (s, e) = (caps[0].unwrap(), caps[1].unwrap());
            out.extend(&chars[pos..s]);
            if literal {
                out.push_str(replacement);
            } else {
                self.expand(replacement, &chars, &caps, &mut out);
            }
            if e == s {
                if let Some(c) = chars.get(s) {
                    out.push(*c);
                }
                pos = s + 1;
            } else {
                pos = e;
            }
        }
        if pos < chars.len() {
            out.extend(&chars[pos..]);
        }
        out
    }

    /// Python's template: `\1`..`\99`, `\g<1>`, `\g<name>`, `\n`, `\t`, `\\`. A group that didn't take part is empty.
    fn expand(&self, template: &str, text: &[char], caps: &[Option<usize>], out: &mut String) {
        let group = |i: usize, out: &mut String| {
            if let (Some(Some(s)), Some(Some(e))) = (caps.get(2 * i), caps.get(2 * i + 1)) {
                out.extend(&text[*s..*e]);
            }
        };
        let t: Vec<char> = template.chars().collect();
        let mut i = 0;
        while i < t.len() {
            if t[i] != '\\' || i + 1 == t.len() {
                out.push(t[i]);
                i += 1;
                continue;
            }
            let c = t[i + 1];
            i += 2;
            match c {
                '0'..='9' => {
                    let mut n = c.to_digit(10).unwrap() as usize;
                    if let Some(d) = t.get(i).and_then(|d| d.to_digit(10)) {
                        n = n * 10 + d as usize;
                        i += 1;
                    }
                    group(n, out);
                }
                'g' if t.get(i) == Some(&'<') => match t[i..].iter().position(|c| *c == '>') {
                    Some(len) => {
                        let name: String = t[i + 1..i + len].iter().collect();
                        let idx = name.parse().ok().or_else(|| self.names.iter().find(|(n, _)| *n == name).map(|(_, i)| *i));
                        if let Some(idx) = idx {
                            group(idx, out);
                        }
                        i += len + 1;
                    }
                    None => out.push_str("\\g"),
                },
                'n' => out.push('\n'),
                't' => out.push('\t'),
                '\\' => out.push('\\'),
                c => {
                    out.push('\\');
                    out.push(c);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub(p: &str, r: &str, t: &str) -> String {
        Regex::new(p).unwrap().replace_all(t, r, false)
    }

    #[test]
    fn literals_and_case() {
        assert_eq!(sub("gpu box", "gpu-box", "Gpu Box is up, gpu box too"), "gpu-box is up, gpu-box too");
        assert_eq!(sub(r"\bpost(?:gress|grez)\b", "postgres", "Postgress and postgrez, not postgressql"), "postgres and postgres, not postgressql");
    }

    #[test]
    fn backrefs_and_named_groups() {
        assert_eq!(sub(r"(\d+) ?gigs?\b", r"\1 GB", "32 gigs and 64gig"), "32 GB and 64 GB");
        assert_eq!(sub(r"gpu[- ]?(one|two)", r"gpu-\g<1>", "gpu one"), "gpu-one");
        assert_eq!(sub(r"(?P<n>\w+) server", r"\g<n>-server", "AMD server"), "AMD-server");
        assert_eq!(sub(r"a(x)?b", r"[\1]", "ab axb"), "[] [x]");
    }

    #[test]
    fn classes_quantifiers_and_anchors() {
        assert_eq!(sub(r"[a-c]{2,3}", "_", "abcd aXd"), "_d aXd");
        assert_eq!(sub(r"[^\s]+$", "END", "one two"), "one END");
        assert_eq!(sub(r"^\s+|\s+$", "", "  hi  "), "hi");
        assert_eq!(sub(r"a.*?b", "X", "aab ab"), "X X");
        assert_eq!(sub(r"x{", "y", "x{"), "y");
        assert_eq!(sub(r"desk ?flow(?!s)", "Deskflow", "desk flow, deskflows"), "Deskflow, deskflows");
        assert_eq!(sub(r"o(?=k)", "0", "ok on"), "0k on");
        assert_eq!(sub("x*", "-", "ab"), "-a-b-");
    }

    #[test]
    fn unsupported_patterns_are_errors_not_guesses() {
        for p in [r"(?<=a)b", r"(a)\1", "(?x)a", "a**", "(a", "a)", "[a", r"\q", "*a"] {
            assert!(Regex::new(p).is_err(), "{p}");
        }
    }

    #[test]
    fn a_runaway_pattern_gives_up() {
        let t = "a".repeat(40);
        assert_eq!(sub("(a*)*b", "x", &t), t);
    }

    #[test]
    fn whole_words_only() {
        let r = Regex::whole_word("Build box");
        assert_eq!(r.replace_all("a build box, build boxes", "build-box", true), "a build-box, build boxes");
        let r = Regex::whole_word("C++");
        assert_eq!(r.replace_all("c++ and C++x", "cpp", true), "cpp and cppx");
    }
}
