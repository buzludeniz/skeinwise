# Releasing Skeinwise 1.0.0: Deniz's checklist

Every step here is yours: no session tags, publishes or logs in. No secret belongs in this file or the repo.

**0. First, if you have no npm account with 2FA.** Sign up at npmjs.com, verify the email, and turn on two-factor
authentication for authorization and writes (a security key or an authenticator app). Store the recovery codes
offline. Then `npm login` (it opens the browser), `npm whoami`, and `npm view skeinwise`: still a 404 means the name
is free.

**1. The rc, by hand (Fri ~15:00, on your yes).** The lead names the RC sha; package.json says `1.0.0-rc.1` there.
```sh
cd "$(mktemp -d)" && git clone https://github.com/buzludeniz/skeinwise.git . && git checkout --detach <RC sha>
node -p "require('./package.json').version"     # 1.0.0-rc.1
pnpm install --frozen-lockfile && pnpm typecheck && pnpm test
npm pack                                         # prepack cleans dist/ and builds it
pnpm pack:check                                  # must end "pack check: clean"
shasum -a 256 skeinwise-1.0.0-rc.1.tgz           # paste the sum to the lead
npm publish skeinwise-1.0.0-rc.1.tgz --tag next --access public    # npm asks for 2FA
npm dist-tag ls skeinwise                        # send the output to the lead
```
If `latest` also shows `1.0.0-rc.1`, that is how npm treats a new package's first version; 1.0.0 moves it.
Then the lead runs the `npx -y skeinwise@next demo` gate on three OSes.

**2. Trusted publisher (after the rc exists).** npmjs.com, package skeinwise, Settings, Trusted publishing, GitHub
Actions:

| Field | Value |
|---|---|
| Organization or user | `buzludeniz` |
| Repository | `skeinwise` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |

On GitHub (repo Settings, Environments), create `npm` with you as required reviewer and deployment tags `v*`. In
Settings, Advanced Security, enable Private vulnerability reporting: SECURITY.md sends reporters there, and it is
off today.
Back on npm, set Publishing access to "Require two-factor authentication and disallow tokens". The config expires
if its first publish isn't done within 2 days: if the go slips past that, add it again.

**3. The signed tag (LS-24, on the go).** It needs a signing key that GitHub knows: an SSH key added under GitHub,
Settings, SSH and GPG keys, as a *Signing key*, and a tagger email GitHub has verified (your noreply address is).
```sh
git config gpg.format ssh && git config user.signingkey ~/.ssh/id_ed25519.pub   # once, in your clone
git fetch origin && git checkout --detach origin/main
node -p "require('./package.json').version"     # 1.0.0
git tag -s v1.0.0 -m "Skeinwise 1.0.0" && git push origin v1.0.0
```
The Release workflow refuses unless the tag is signed and verified, names package.json's version, sits on main,
and CHANGELOG.md has a `## [1.0.0]` section. Approve the `npm` environment when it asks. Afterwards:
`npm view skeinwise dist-tags` shows `latest: 1.0.0`, and the GitHub release carries the tarball and SHA256SUMS.

**If you say no to the rc:** push the tag as in step 3. The publish job fails, because the package doesn't exist
yet. Then `gh run download <run id> -R buzludeniz/skeinwise -n package`, `shasum -a 256 -c SHA256SUMS`, and
`npm publish skeinwise-1.0.0.tgz --access public`. Re-run the failed jobs: publish sees the same bytes on npm and
passes, and the GitHub release follows. Add the trusted publisher (step 2) for 1.0.1.
