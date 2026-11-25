<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo-mark-dark.svg">
  <img src="brand/logo-mark.svg" alt="" width="40" height="40">
</picture>

# Skeinwise: connectors

Connectors read four work tools into the record: Gmail, Google Calendar, Todoist and Slack. What they read becomes
ordinary entries, so search, ask, the organiser and the local model treat a mail or a task like any other note.

They only read. No connector sends, posts, deletes, completes, answers or changes anything, and none marks anything
as read.

## How they work

- **Consent first.** `skeinwise connect <service>` prints what the connector reads, each permission it asks for and
  why, and where the token will live, before any sign-in. Then it asks; `--yes` answers for you.
- **Your own client.** Skeinwise ships no OAuth client, client secret or key, and creates no account or app for you.
  You make your own app with each service, in a few minutes; the sections below say how.
- **Tokens live in the macOS Keychain**, as generic passwords with the service `skeinwise` and the account
  `<record id>/<service>/token` (and `/client-secret` for a client secret). The record id is the first 12 hex digits
  of a hash of the record folder's path, so two record folders never share a token. Keychain Access shows them under
  "skeinwise". A token is never written to a file, the config, a log or the repo.
- **`connections.json`** in the record folder (owner-only) holds each connection's account, the channels or calendars
  you picked, and where the last pull stopped. It holds no token.
- **macOS only, for now.** Elsewhere `connect` says it isn't supported yet: Skeinwise has no equally safe place for a
  token there.
- **Where it lands.** Each connection is one source, labelled `gmail:<account>`, `calendar:<account>`,
  `todoist:<account>` or `slack:<workspace>`. One thread per mail thread, calendar, Todoist project or Slack channel.
  Dedupe and versions work as they do for imports: pulling the same item twice adds nothing, and a changed item becomes
  a new version.
- **Pulls.** The first pull reaches back to `--from` (default: 90 days ago). Later pulls ask only for what changed.
  `skeinwise live` pulls every 5 minutes, or a minute after a pull that left more to read;
  `skeinwise connections --pull` pulls now.
- **Trouble is a status line, never a crash.** When a service asks Skeinwise to slow down, what was read so far is
  kept and the next pull waits as long as it asked. When a service is down, the next pull is in 5 minutes. When the
  access was revoked or ran out, pulls stop until you run `skeinwise connect <service>` again.
  `skeinwise connections` shows each line.
- **Deleted at the service, kept here.** An item deleted in Gmail, Calendar or Todoist stays in the record. The status
  line counts it ("2 deleted in Gmail (kept here)").

## Commands

| Command | Does |
|---|---|
| `skeinwise connect <service>` | Shows the consent, signs in, saves the token to the Keychain, and pulls |
| `skeinwise connections [--pull] [--json]` | What is connected, how the last pull went, when the next one is |
| `skeinwise disconnect <service> [--keep \| --drop]` | Revokes the access, deletes the token, keeps or leaves out what was read |

`connect` takes `--client-id <id>` (Gmail, Calendar, Todoist), `--client-secret-file <file>`, `--token-file <file>`
(Slack), `--channels <names>` (Slack), `--calendars <ids>` (Calendar), `--from <date>`, `--port <port>` (Todoist) and
`--yes`. A secret or token is never taken as a flag's value, which would sit in the shell's history: Skeinwise asks
for it without showing what you type, or reads it from a file.

## Gmail

| Permission | Why |
|---|---|
| `https://www.googleapis.com/auth/gmail.readonly` | Read your mail. It can't send, delete, label or mark anything. Google's narrower `gmail.metadata` has no message bodies, so it can't do the job |

- **Reads:** your mail from `--from` on, except spam, trash, drafts and chats. Quoted text under a reply is cut, so a
  thread doesn't repeat itself. HTML mail is read as text. Attachments are listed by name and never downloaded.
- **Then:** what Gmail's history says was added since the last pull. A pull reads up to 100 messages, so a big
  backlog spreads over a few minutes.
- **Your client:** see [Your Google client](#your-google-client). Then:
  `skeinwise connect gmail --client-id <your client ID>`.

## Google Calendar

| Permission | Why |
|---|---|
| `https://www.googleapis.com/auth/calendar.readonly` | Read your calendars and their events. It can't create, change, delete or answer anything |

- **Reads:** the events on your main calendar, or the ones you name with `--calendars` (a calendar's ID is in Google
  Calendar's settings, under "Integrate calendar"), from `--from` on. One entry per event: its title, when, where, who
  else is invited, how it repeats, and its description.
- **Then:** what changed, using the calendar's sync token. A moved event becomes a new version. A cancelled one is
  counted and kept.
- **Your client:** the same Google client as Gmail works. Then:
  `skeinwise connect calendar` (it reuses Gmail's client ID), or `--client-id <your client ID>`.

### Your Google client

Gmail and Calendar sign in with Google's OAuth for desktop apps: PKCE, and a redirect to `http://127.0.0.1` on a
free port that Skeinwise opens only for the sign-in. Google allows any loopback port for a Desktop client, so there is
nothing to register.

1. In the Google Cloud console, create a project, or pick one of yours.
2. Under APIs & Services, enable the **Gmail API**, the **Google Calendar API**, or both.
3. Set up the consent screen (Google Auth Platform):
   - **User type:** External, or Internal if your account is in a Google Workspace you manage.
   - **App name and email:** anything you like.
   - **Scopes (Data Access):** `gmail.readonly` and/or `calendar.readonly`.
   - **Test users (Audience):** add your own address.
4. Under Clients, create a client of type **Desktop app**. Copy its client ID.
5. Google shows a client secret for a Desktop client too. For an app on your own computer it isn't really secret, but
   give it when `connect` asks: Skeinwise keeps it in the Keychain, next to the token. `--client-secret-file` reads
   it from a file instead.

An External app in Testing gets a sign-in that Google ends after 7 days. When `skeinwise connections` says Gmail or
Calendar is signed out, run `skeinwise connect` again. An Internal app (Workspace) has no such limit.

If Gmail and Calendar share one client, disconnecting one may end the other's access too: Google can revoke every
grant a client holds at once. `disconnect` says so when it applies.

## Todoist

| Permission | Why |
|---|---|
| `data:read` | Read your projects, tasks and labels. It can't add, change, complete or delete anything |

- **Reads:** your active tasks, one thread per project. A task's entry has its text, description, due date (and how it
  repeats), priority and labels.
- **Then:** what changed, through Todoist's Sync endpoint with the sync token from the last pull. The request carries
  no commands, so it only reads. A completed task becomes a new version ending "Done <date>". A deleted one is counted
  and kept.
- **Sign-in:** Todoist's OAuth needs a client secret, and its app console takes one fixed redirect URL. So you
  register `http://127.0.0.1:8735/` (or a port of your choosing, passed as `--port`), and Skeinwise listens there only
  for the sign-in.

**Your Todoist app:**

1. Open Todoist's App Management Console (developer.todoist.com, signed in) and create an app with any name.
2. Set its **OAuth redirect URL** to `http://127.0.0.1:8735/`.
3. Copy the **Client ID** and the **Client secret**.
4. Run `skeinwise connect todoist --client-id <your client ID>`. Paste the secret when asked, or pass it as
   `--client-secret-file <file>`. Skeinwise keeps it in the Keychain: it renews the access with it, and revokes the
   access with it when you disconnect.

## Slack

| Permission (user scope) | Why |
|---|---|
| `channels:history` | Read messages in the public channels you pick |
| `channels:read` | Find those channels by name |
| `groups:history` | Read messages in the private channels you pick (only ones you are in) |
| `groups:read` | Find those private channels by name |
| `users:read` | Show people by name instead of by ID |

- **Reads:** the top-level messages in the channels you pick with `--channels`, from `--from` on. Mentions, channel
  links and links are turned into plain text. Joins, leaves and topic changes are left out. Your own messages read as
  "you".
- **Then:** the messages newer than the newest one read.
- **Sign-in:** installing your own Slack app hands you its token, so there is no sign-in to run. You make the app with
  the scopes above, install it to your workspace, and paste its User OAuth Token. Skeinwise checks the token's scopes
  and refuses one that can do more than read, and refuses a bot token (`xoxb-`), which reads as the app rather than as
  you.

**Your Slack app:**

1. At api.slack.com/apps, choose **Create New App**, then **From a manifest**, and pick the workspace you want to
   read. An app made in the workspace it reads is an internal app, which keeps Slack's usual limits for reading
   history.
2. Paste this manifest:

   ```yaml
   display_information:
     name: Skeinwise (read-only)
   oauth_config:
     scopes:
       user:
         - channels:history
         - channels:read
         - groups:history
         - groups:read
         - users:read
   settings:
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```

3. Choose **Install to Workspace** and allow it. Some workspaces need an admin to approve the app first.
4. Under **OAuth & Permissions**, copy the **User OAuth Token** (it starts with `xoxp-`).
5. Run `skeinwise connect slack --channels general,team-notes` and paste the token when asked. Or save it to a file
   only you can read, pass it as `--token-file <file>`, and delete the file afterwards.

## Disconnecting

`skeinwise disconnect <service>`:

1. Asks whether to keep the items it read in search. `--keep` or `--drop` answers ahead of time, and is required
   when there is no terminal to ask on.
2. Revokes Skeinwise's access at the service: Google's revoke endpoint, Todoist's revoke endpoint (with your client),
   or Slack's `auth.revoke`. If the service can't be reached, it says how to remove the access yourself:
   - **Google:** myaccount.google.com/permissions.
   - **Todoist:** Settings, then Integrations.
   - **Slack:** uninstall your app in its settings.
3. Deletes the token and the client secret from the Keychain, and the connection from `connections.json`.
4. With `--drop`, leaves the items out of search and the map. `skeinwise include <source id>` brings them back, and
   so does connecting again. They stay in `record.db`: the record can't delete a source yet.

## Limits, for now

- **Gmail:** label changes and read or unread state aren't followed. Attachments are listed by name only.
- **Calendar:** a repeating event is one entry, with its rule. An occurrence you change on its own arrives as its own
  entry.
- **Todoist:** comments and sections aren't read. Tasks completed before you connected aren't read.
- **Slack:** thread replies, edits, deletions and direct messages aren't read.
- **Everywhere:** an item deleted at the service stays in the record.
