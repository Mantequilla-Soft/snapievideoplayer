# 3Speak partner integration

Embed 3Speak videos in your app and have your viewers earn a share of ad revenue.
No player SDK and no frontend work: an iframe, plus a little code on your server.

There are three things to do.

1. [Record the viewer's opt-in (and opt-out)](#1-opt-in-and-opt-out)
2. [Mint a viewer token for a video](#2-mint-a-viewer-token)
3. [Build the embed URL](#3-build-the-embed-url)

**What you need from us:** an `appId` and a `secret`. Ask and we will issue them.
The secret stays on your server, never in your frontend, your repo, or a URL.

---

## 1. Opt-in and opt-out

Paying someone means naming them, so the viewer has to agree to their username being
stored with what they watch. That agreement is a **message signed by their Hive posting
key**, because consent nobody can prove was given is not consent.

You collect this in your own app, with your own wallet integration. Nobody gets sent
to 3speak.tv.

### Check what they have already answered

```
GET https://checker.3speak.tv/advertise/viewer/prefs/<account>
```

```json
{ "success": true, "account": "alice", "rewardsEnabled": false,
  "decided": false, "updatedAt": null }
```

🚨 **Three states, not two.** `decided` tells "declined" apart from "never asked".
Prompt on `decided === false`. Prompting on `rewardsEnabled === false` nags everybody
who already said no. Read this from the server, never from local storage, or you will
re-ask per device and re-ask people who declined elsewhere.

### Build the exact message

```
3speak-ads|viewer-prefs|<account>|on|<timestampMs>      ← opting in
3speak-ads|viewer-prefs|<account>|off|<timestampMs>     ← opting out
```

- `timestampMs` is `Date.now()`, in **milliseconds**, and must be within **±5 minutes**
  of our clock.
- Byte for byte. A different separator, casing or spacing will not verify.

### Sign it

A standard Hive message signature: the **sha256 of the UTF-8 message**, signed with the
account's **posting** key. This is what Keychain's `requestSignBuffer(account, message,
'Posting')` and aioha's `signMessage(message, KeyTypes.Posting)` both produce. Send the
signature string as-is.

An account that has granted posting authority to `@threespeak` may also have it signed
by that delegate, which is how viewers with no key in the browser opt in.

### Send it

```
POST https://checker.3speak.tv/advertise/viewer/prefs
Content-Type: application/json

{ "account": "alice", "rewardsEnabled": true,
  "signature": "<hive signature>", "timestamp": 1758400000000 }
```

```json
{ "success": true, "account": "alice", "rewardsEnabled": true,
  "decided": true, "removedWatchRows": 0 }
```

Opting out is the identical call with `rewardsEnabled: false` and `off` in the message.

⚠️ **Opting out deletes the rows already collected**, and `removedWatchRows` tells you
how many. "Stop storing my username" is meaningless if the answer is "from now on", so
this is a real delete, not a flag.

### Things that will bite you

| Symptom | Cause |
|---|---|
| `Invalid signature` | Message not byte-identical, or signed with the wrong key type |
| `timestamp out of tolerance` | Clock drift, or the timestamp signed differs from the one sent |
| `Signature required` | `signature` or `timestamp` missing |
| `Hive account not found` | The account does not exist on chain |

**Use the same timestamp in the message and in the body.** Generating it twice is the
most common way to fail this.

💡 **The server will tell you the exact message shape.** POST without a signature and it
answers with `expected_message`:

```json
{ "success": false, "error": "Signature required",
  "expected_message": "3speak-ads|viewer-prefs|alice|on|<ms>" }
```

---

## 2. Mint a viewer token

The viewer's name decides whose reward ledger a watch lands in, and that ledger pays
real money. So the embed will not take a name in the clear: it has to arrive signed with
your key. That also means every row is attributable to your app, and revocable if it is
ever abused.

**On your server, once per page view:**

```js
const crypto = require('crypto');

const b64url = (b) => Buffer.from(b).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function mintViewerToken({ app, secret, viewer, video, ttlSeconds = 600 }) {
  const payload = b64url(JSON.stringify({
    v: viewer.toLowerCase(),        // Hive account to credit
    a: app,                         // your appId
    p: video.toLowerCase(),         // "owner/permlink"
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  }));
  const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}
```

```js
const vt = mintViewerToken({
  app: 'partnerapp',
  secret: process.env.THREESPEAK_SECRET,
  viewer: 'alice',
  video: 'alfasuenos/alfasueos-teatro-en-vivo-425',
});
```

It is plain HMAC-SHA256, so any language does this in a few lines.

### Rules

- **`ttlSeconds` must be 900 or less.** A longer claim is rejected outright. Mint per
  page view; 600 is a sensible default.
- **One token, one video.** It is bound to that `owner/permlink`, so a token that leaks
  out of the URL buys the watch it was already for and nothing else.
- **Either permlink form works.** The Hive post's or the asset's; we resolve both.
- **Lowercase** the account and the `owner/permlink` before signing, or the signature
  will not match what we verify.
- Mint only for a viewer who has opted in. We re-check the opt-in server-side anyway, so
  a token for somebody who declined simply records nothing.

---

## 3. Build the embed URL

```html
<iframe
  src="https://play.3speak.tv/embed?v=alfasuenos/alfasueos-teatro-en-vivo-425&mode=iframe&vt=TOKEN"
  allowfullscreen
  style="width:100%;aspect-ratio:16/9;border:0">
</iframe>
```

| Parameter | |
|---|---|
| `v` | `owner/permlink`, required |
| `mode=iframe` | embedded chrome, recommended |
| `vt` | your token. Omit it and playback works exactly as before, anonymously |

Use `/embed?v=` for current uploads and `/watch?v=` for legacy ones.

You do **not** need `?viewer=` as well. The player reads the name out of the token,
which is also how we recognise a Pro subscriber and skip their ads.

> ⚠️ **Rolling out.** If tokens are not being honoured on `play.3speak.tv` yet, ask us
> for a test endpoint. Everything else about the integration is identical.

---

## What has to be true for a viewer to earn

Checked on our side, every time, and none of it is taken from your request:

- **They opted in**, re-read from our database on every watch.
- They watched **at least 75%**, measured as unique timeline coverage, so seeking to the
  end counts as one bucket rather than a full view.
- They are **not the video's owner**, and not in private mode.
- Credited seconds are capped at **20 minutes per video**, and one row per viewer+video
  keeps its best figure rather than summing replays.

**Pro subscribers earn too.** They see no ads, but the pool comes out of the platform's
own share, so their watch time still counts.

A viewer who has not opted in earns nothing, and nothing is stored about them.

## Two things that look like bugs and are not

- **At most one ad per page load.** The frequency cap is keyed to an id generated per
  page load, so loading several videos without refreshing will correctly serve one spot
  and then stop. This is the most common "it is broken" report.
- **A bad token costs the credit, never the video.** Expired, tampered, or an unknown
  app all fall through to an anonymous session. The video plays, the view still counts,
  nobody's ledger is touched.
