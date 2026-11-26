# Releasing Skeinwise 1.0.0: Deniz's checklist

Every step here is yours: no session tags, publishes or logs in. No secret belongs in this file or the repo. The steps
are in the order you meet them. "Verified" names the page a step was checked against on Nov 26; "not verified" means
no page said so.

**First, before any `v*` tag: the `npm` environment on GitHub.** release.yml's publish job runs in the environment
`npm`, which doesn't exist yet (the repo listed no environments on Nov 26). A run that names a missing environment
creates it with no protection rules, so a tag pushed before you set it up would publish without waiting for you.
Verified, [Managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments):
"Running a workflow that references an environment that does not exist will create an environment with the
referenced name", and, outside Pages builds, "the newly created environment will not have any protection rules or
secrets configured." In the repo's Settings, Environments, New environment, name it `npm`, then:
- **Required reviewers:** you. Required reviewers work on a public repo on the Free plan (verified, same page).
- **Prevent self-review:** leave it off. Your own tag push starts the run, and with it on, "users who initiate a
  deployment cannot approve the deployment job, even if they are a required reviewer". Verified,
  [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
  That you can approve your own run with it off: not verified (the page doesn't say).
- **Deployment branches and tags:** "Selected branches and tags", then Add deployment branch or tag rule, Ref type
  Tag, pattern `v*` (verified, both pages). That `v*` matches `v1.0.0`: not verified. The pages give `File.fnmatch`
  syntax, where `*` matches anything but `/`.

Set it up before step 3: npm's trusted-publisher form names this environment.

**0. If you have no npm account with 2FA.** Sign up at npmjs.com, verify the email, and turn on two-factor
authentication for authorization and writes (a security key or an authenticator app). Store the recovery codes
offline. Then `npm login` (it opens the browser), `npm whoami`, and `npm view skeinwise`: still a 404 means the name
is free.

**1. Before the rc goes out: Private vulnerability reporting.** SECURITY.md sends reporters to it, and it is off
(the API said so on Nov 26). An installable package needs a working route for reports. In the repo's Settings,
Advanced Security, click Enable beside "Private vulnerability reporting". Verified,
[Configuring private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository):
"Under "Advanced Security", to the right of "Private vulnerability reporting", click **Enable**".

**2. The rc, by hand (Fri ~15:00, on your yes).** The lead names the RC sha; package.json says `1.0.0-rc.1` there.
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
`latest` may also show `1.0.0-rc.1` on a new package's first version (not verified: npm's docs don't cover it);
1.0.0 moves it. Then the lead runs the `npx -y skeinwise@next demo` gate on three OSes.

**3. Trusted publisher: after the rc exists, and no more than 2 days before the v1.0.0 tag.** A new configuration
must make its first publish within 2 days. Verified, [Trusted publishing](https://docs.npmjs.com/trusted-publishers):
"A newly created trusted publisher configuration must complete its first successful publish within 2 days", and
otherwise "it expires and can no longer be used or edited": delete it, add it again, and publish within 2 days.
The package must exist first, which the rc does (verified,
[npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust)).

npmjs.com, package skeinwise, Settings, Trusted publishing, GitHub Actions. Every field is case-sensitive and must be
exact (verified, Trusted publishing, Troubleshooting):

| Field | Value |
|---|---|
| Organization or user | `buzludeniz` |
| Repository | `skeinwise` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |
| Allowed actions | also allow `npm publish`; leave `npm dist-tag` off |

**Allowed actions: allow direct publishing.** Configurations made since September default to staged publishing
only. Verified, Trusted publishing: "Configurations created after Sep 03, 2026 are automatically set to allow `npm
stage publish`". The form lets you "Choose whether this trusted publisher can also publish directly with `npm
publish`". release.yml's publish job runs a plain `npm publish`, so choose it.
- What a stage-only configuration does to that `npm publish`: not verified. No npm page names the error; npm's table
  says an OIDC token "Can publish (if allowed)" ([npm stage](https://docs.npmjs.com/cli/v12/commands/npm-stage)).
- Why direct rather than release.yml moving to `npm stage publish`, though npm recommends stage-only ("We encourage
  you to only enable `npm stage publish` on your trust relationships", npm stage, Best Practices):
  - npm's docs don't say a staged publish carries provenance. CHANGELOG.md and docs/security.md promise provenance.
  - A staged version goes live only when you approve it on npmjs.com with 2FA (verified,
    [Staged publishing](https://docs.npmjs.com/staged-publishing)). release.yml's GitHub release and its safe re-run
    both assume the version is live when the job ends, so both would change.
  - A staged release can't be rehearsed short of a real publish, and the `npm` environment's required reviewer is
    already a human gate on every publish.
  - Staging is worth a look for 1.1, once npm documents provenance for it.

Then set Publishing access to "Require two-factor authentication and disallow tokens". Trusted publishing keeps
working: "Your trusted publishers will continue to work normally, as they use OIDC tokens" (verified, Trusted
publishing).

**4. The signed tag (LS-24, on the go).** It needs a signing key that GitHub knows: an SSH key added under GitHub,
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

**If you say no to the rc:** set up the `npm` environment (the first step) and push the tag as in step 4. The publish
job fails, because the package doesn't exist yet. Then `gh run download <run id> -R buzludeniz/skeinwise -n package`,
`shasum -a 256 -c SHA256SUMS`, and `npm publish skeinwise-1.0.0.tgz --access public`. Re-run the failed jobs:
publish sees the same bytes on npm and passes, and the GitHub release follows. Add the trusted publisher (step 3) for
1.0.1.
