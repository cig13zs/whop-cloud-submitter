# register/

Drop a `.txt` file here to register clips with the runner. No `gh`, no workflow dispatch, no message to anyone.

Each non-empty line that does not start with `#` is one registration, encrypted to `register.pub` in the repo root. The repo is public, so nothing here is plain text.

Make a line (Linux, OpenSSL 1.1.1 or newer):

```bash
printf '%s' 'VIDEOID=CAMPAIGN-UUID' | openssl pkeyutl -encrypt -pubin -inkey register.pub -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 | base64 -w0
```

Or with Node:

```bash
node -e "console.log(require('crypto').publicEncrypt({key:require('fs').readFileSync('register.pub'),oaepHash:'sha256'},Buffer.from(process.argv[1])).toString('base64'))" 'VIDEOID=CAMPAIGN-UUID'
```

Rules:

- One file per batch, any new name ending in `.txt` (for example `2026-11-12-morning.txt`). Add files; do not edit old ones. The file name must not contain a video id.
- Register a clip when it is scheduled. A private video is watched and submitted in the first run after it goes public. Runs are about 2.5 minutes apart.
- `VIDEOID` alone works only on a single-campaign channel in the channel map. Send the campaign.
- Keep scheduled clips Private, not Unlisted.
- Encrypting the same text twice gives two different lines. Both are accepted; the second does nothing.

The answer is in `registrations.ack` in the repo root, one line per registration: the first 12 hex characters of the line's SHA-256, then the status.

```bash
printf '%s' "$LINE" | sha256sum | cut -c1-12
```

| status | meaning |
|---|---|
| `watching` | registered, not public yet |
| `public, submitting` | seen public, submit in progress |
| `submitted` | Content Rewards has it |
| `pending, retried next run` | a lookup failed this run; nothing to do |
| `REJECTED ...` | not taken: unreadable line, unknown campaign id, or a public video with no campaign. Fix by adding a new line. The run that first sees it fails once |
| `MISSED ...` | public for 28 minutes without a submit |
| `refused by Content Rewards` | Content Rewards turned it down |
