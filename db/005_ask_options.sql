-- Asks with options: the assistant offers a list (the roles it would apply for, say), and the owner picks some of them, or none. `options` is null for a
-- plain ask. Each option is `{"key", "label", "detail", "link"?}`; the words are hers, and may quote postings written by strangers.
-- `picked` is the keys the owner picked, set only by the answer `pick`, which leaves the ask `accepted`. "None of these" is `denied`, and a reply
-- keeps `picked` null. The gateway checks the same rules first (data/asks.rs, `check_options`), so these only catch what got past it.

create function ask_options_ok(o jsonb) returns boolean language plpgsql immutable as $$
declare
  e jsonb;
  k text;
  keys text[] := '{}';
begin
  if jsonb_typeof(o) <> 'array' or jsonb_array_length(o) not between 1 and 20 then
    return false;
  end if;
  for e in select * from jsonb_array_elements(o) loop
    if jsonb_typeof(e) <> 'object' then
      return false;
    end if;
    for k in select * from jsonb_object_keys(e) loop
      if k not in ('key', 'label', 'detail', 'link') then
        return false;
      end if;
    end loop;
    if jsonb_typeof(e->'key') is distinct from 'string' or jsonb_typeof(e->'label') is distinct from 'string'
       or jsonb_typeof(e->'detail') is distinct from 'string' or (e ? 'link' and jsonb_typeof(e->'link') <> 'string') then
      return false;
    end if;
    if btrim(e->>'key') = '' or e->>'key' <> btrim(e->>'key') or char_length(e->>'key') > 40 or e->>'key' ~ '[[:cntrl:]]'
       or btrim(e->>'label') = '' or char_length(e->>'label') > 120 or e->>'label' ~ '[[:cntrl:]]'
       or char_length(e->>'detail') > 400
       or (e ? 'link' and (char_length(e->>'link') > 500 or e->>'link' !~ '^https://[^[:space:][:cntrl:]/?#]+([/?#][^[:space:][:cntrl:]]*)?$')) then
      return false;
    end if;
    if (e->>'key') = any(keys) then
      return false;
    end if;
    keys := keys || (e->>'key');
  end loop;
  return true;
end
$$;

-- Picked keys: at least one, no repeats, each one of the options'.
create function ask_picked_ok(o jsonb, picked text[]) returns boolean language sql immutable as $$
  select cardinality(picked) >= 1
     and cardinality(picked) = (select count(distinct p) from unnest(picked) p)
     and picked <@ array(select e->>'key' from jsonb_array_elements(o) e)
$$;

alter table asks
  add column options jsonb check (options is null or ask_options_ok(options)),
  add column picked text[],
  -- An ask with options is accepted only by saying which, and only such an ask has `picked`.
  add constraint asks_picked_check check (
    (picked is not null) = (status = 'accepted' and options is not null)
    and (picked is null or ask_picked_ok(options, picked))
  );
