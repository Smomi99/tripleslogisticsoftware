-- Usernames are matched case-insensitively (CLAUDE.md §7 login).
--
-- Case-sensitive matching meant "SuperAdmin" resolved to no such user, which is
-- indistinguishable from a wrong password at the login screen. Normalising on
-- write and read is simpler than a functional index, and the CHECK below makes
-- the invariant impossible to break from any code path.
--
-- Passwords are untouched: only the username is normalised.
UPDATE "user" SET username = lower(username) WHERE username <> lower(username);

ALTER TABLE "user"
  ADD CONSTRAINT "user_username_lowercase_check"
  CHECK (username = lower(username));
