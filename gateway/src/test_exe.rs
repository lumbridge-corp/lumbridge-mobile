//! Fake tools for the tests, written so that running them can't fail with `ETXTBSY` ("Text file busy").
//!
//! The race: a test writes its fake with `fs::write` and chmods it. While that write descriptor is open, another test thread
//! forks to spawn its own child, and the child holds a copy of the descriptor until it execs (`O_CLOEXEC` closes it at exec,
//! not at fork). If the first test execs its fake in that window, the kernel refuses with `ETXTBSY`, and the product maps a
//! spawn error to 503. Writing to a temp name and renaming it into place doesn't help: the leaked descriptor points at the
//! same inode, which the rename keeps. What helps is that this process never holds a write descriptor on a file it will run,
//! so `install` writes the executable, and has exited before the test spawns anything.

use std::path::Path;

/// Writes `body` to `path` as an executable (0755). The body goes first to `<path>.body`, which is never run, and `install`
/// copies it into place.
pub fn write_exe(path: impl AsRef<Path>, body: impl AsRef<[u8]>) {
    let path = path.as_ref();
    let mut staged = path.as_os_str().to_owned();
    staged.push(".body");
    let staged = std::path::PathBuf::from(staged);
    std::fs::write(&staged, body).unwrap();
    let out = std::process::Command::new("install").arg("-m").arg("0755").arg(&staged).arg(path).output().unwrap();
    assert!(out.status.success(), "install {}: {}", path.display(), String::from_utf8_lossy(&out.stderr));
    std::fs::remove_file(&staged).unwrap();
}

/// New tests write their fakes with `write_exe`, not `fs::write` and a chmod: every file in src/ but this one is read for a
/// mode that makes something executable.
#[test]
fn every_fake_tool_is_written_with_write_exe() {
    fn files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                files(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }
    let mut paths = Vec::new();
    files(Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src")), &mut paths);
    let mut hits = Vec::new();
    for p in paths.iter().filter(|p| !p.ends_with("test_exe.rs")) {
        for (n, line) in std::fs::read_to_string(p).unwrap().lines().enumerate() {
            if ["from_mode(0o7", "0o755", "0o775"].iter().any(|bad| line.contains(bad)) {
                hits.push(format!("{}:{}: {}", p.display(), n + 1, line.trim()));
            }
        }
    }
    assert!(hits.is_empty(), "write fake tools with crate::test_exe::write_exe (see its doc for why):\n{}", hits.join("\n"));
}

#[test]
fn write_exe_leaves_an_executable_and_no_body() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("tool");
    write_exe(&bin, "#!/bin/sh\necho hi\n");
    assert_eq!(std::fs::metadata(&bin).unwrap().permissions().mode() & 0o777, 0o755);
    assert!(!dir.path().join("tool.body").exists());
    let out = std::process::Command::new(&bin).output().unwrap();
    assert_eq!(out.stdout, b"hi\n");
}
