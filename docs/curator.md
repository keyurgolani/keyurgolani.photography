# The curator

The curator is the private side of the site, where you review new photographs before they reach the draft (#14). It runs as its own service, `curator`, from the same image as `web`. Only `/curation/**` and `/api/curation/**` are curator paths. You sign in at `/curation/login`, and `/curation` leads to the inbox, `/curation/inbox`, where each item the watcher opened waits for you: approve a new photograph into the draft (**Approve into draft**), edit its suggestion (**Save edits**), leave it for later (**Decide later**, which keeps it a draft suggestion), dismiss it with a reason, retry processing, or reopen it. A replacement's new version goes into the draft with **Confirm new asset revision** once its derivatives are built, as `curation confirm` does. A missing source is settled with **Bind**, which gives the photograph the new file the watcher found at its last path, or another library path you type, and waits for the watcher's next pass to apply it, or with **Archive**, which takes a reason and a second confirm, takes the photograph out of every series in the draft, and is a takedown at the next publish, as `curation bind` and `curation archive` do ([data-root.md](data-root.md)). On a replacement confirmed and then reopened, **Decide later** puts the photo record back on the revision that confirm replaced, as `curation defer` does ([data-root.md](data-root.md)). The item says so before you click, and the answer says so after. When the draft already uses the new version, Decide later keeps it and says the next publish uses it. When the draft moved to another version after the confirm, or the earlier version isn't ready to show, the inbox shows Decide later disabled and says why: for a moved draft, set the version with `photos edit` or dismiss the item; for an earlier version that isn't ready, dismiss the item to keep the new version, or leave it open until the earlier version is ready, then choose Decide later to put that one back. `curation show` and reopen's note say the same. `curation defer` refuses the same way and writes nothing. None of them publishes, and an item that changed since the page loaded is turned away with nothing written, so refresh and review it again. Photograph previews and the list's thumbnails come from `/api/curation/media/`, which serves a derivative set to the curator only and is never cached. A row's thumbnail is its set's smallest WebP, never the original; a row with no ready set shows a plain square. A file the watcher couldn't process says why at the top of its item, and what you can do about it: for a format it doesn't read, export the photograph as a JPEG, PNG or WebP into the library, then dismiss the failed one with a reason.

When the watcher hasn't checked in for more than 5 minutes, or has never written its heartbeat, the inbox says so in a strip under the header, above the list and the item, with the time it last checked in: new photographs won't appear until it runs again. On a phone, an item opened from a link lands below the strip, so the item starts with a line that links back up to it. `photos status --check` fails on the same heartbeat ([data-root.md](data-root.md#curation-inbox)).

The list shows 50 items a page, with **Previous page** and **Next page** under it, and each row says how long ago its item opened. **Status** and **Type** filter it, with **Apply filters**; the Type list has every kind of item, the library being unavailable included, and the filters stay on as you open items and move between pages. A checkbox beside each row that can take one selects it for **Decide later on selected** (the mockup's "Leave in draft") or **Leave selected unassigned**. Decide later on selected takes new photographs and files the watcher couldn't process; a replacement, a missing source, an identity question or the library item is decided on its own page, and the server refuses any other. Leave selected unassigned approves each selected new photograph into the draft with no series, keeping any description saved on it; an item with a series saved on it isn't offered, and the server refuses one too. Each row sends the version the page showed, so an item that changed since is left as it is while the rest go through, and a summary lists each one left alone, with a link to it. An item that went through with something to say, such as an approval that waits for a description, is listed under the answer. When an action on an item is refused, one summary says why and links the item and the field it's about.

While the page is open it asks `/api/curation/inbox/summary` every minute, and when you come back to the tab, how many items arrived since the page loaded and whether the watcher checks in. Arrivals are counted by the server's own order (`curation/arrivals/`, [data-root.md](data-root.md)), not by the count going up, so a new item that came in while another was decided elsewhere is still said. It says once when new items arrive, with a link to refresh, and updates the watcher strip. If the item you have open changed meanwhile, in another tab or from the command line, an alert says so, and whatever you typed stays in the form. Offline, or when the server can't be reached, the top of the inbox says so until a check gets through. When the browser comes back online it checks at once, or 2 seconds after the last check started if that was more recent, and if the tab is hidden then, once you're back on it. The check stops on its own after about two hours, and quietly once your session ends. The updates region carries `data-watch`, which nothing shows or reads out: `armed` once the first check is scheduled, `stopped` once the check has stopped for good. Browser tests wait on it. The route is a curator route like the media one: it needs a session, takes GET only, is never cached, and answers counts and the open item's version, never a path or a file name.

A new photograph's suggested position follows its capture date: after the last photograph in the suggested series captured on or before it, at medium confidence. One with no capture date, or a series with none dated, goes at the end, at low confidence. Capture dates are the camera's own day, so two photographs of one day are a tie, and the newer goes after. When you approve without choosing a position, the position is worked out again against the series as it is then, so a batch of a few days lands in date order, and a suggested neighbour that has left the series sends it to the end.

After **Approve into draft** or **Decide later**, the inbox opens the next item that needs a decision, in list order, starting again from the top after the last one, and says at the top of it what it just did, naming the file. That answer links back to the item you decided, where **Reopen** is. Once nothing needs a decision, it shows the empty state. On a phone it shows one thing at a time: the list, or the item you opened, with **Back to inbox** (or the browser's Back) returning to the list where you left it.

## Series

`/curation/series` (#150) lists every series in the draft, in Work order and then by title, each with its visibility (Published, Draft or Hidden), how many photographs it holds, and whether `photos carry-over` brought it over at the launch. **New series** takes a title, and a web address if you want one other than the title's, and makes a draft with no photographs, as `photos edit ser_<name>` does. The web address has to be free: no other series may use it, now or as an old address, and the site's own routes, such as `work`, are taken. One made from the title gets `-2`, `-3` and so on when it isn't free, spells letters such as ł, ß and æ out (l, ss, ae), and asks you to type one when the title has letters a web address can't hold. While any series can't be read, New series waits, since its address can't be checked against that one.

A series' page edits its title, statement, short statement and visibility, with `photos edit`'s rules and limits (a title up to 200 characters, a statement 2,000, and a short statement 500, on one line). **Save** writes the draft only, under the version the page loaded: if the series changed since, say from the command line, or a publish or rollback happened, nothing is written and the page asks you to refresh. It never changes the series' photographs, or Gallery's carry-over marker, which goes once you write either of Gallery's statements, as it does from the command line.

Under the text, the page orders the series, through the same operations as `photos sequence`:

- **Sequence** lists its photographs in order, each by its title, or its file's name, with a thumbnail and whether it's the cover, the opening photograph or a chapter's start. **Move up**, **Move down** and **Remove** are on each row; a move keeps focus on the button you pressed, on the photograph's new row, so pressing it again moves it on. **Add a photograph** adds one at the position you choose. It offers only photographs the Inbox has approved whose file is in the library, and for a published series, none another published series holds, since a photograph belongs to one published series. One in a draft series stays there too. **Move to a position** moves one straight to its place, for a long series.
- **Cover and opening photograph** sets the cover, and its focal point if you want one, as two percentages: how far across, and how far down. The opening photograph is the one Home starts the series on while it's featured; **None** starts it on the first photograph.
- **Chapters** lists each chapter by its title and start. **Move start** and **Remove chapter** are on each; **Add a chapter** takes a title, cleaned as `photos sequence chapter add` cleans it, and the photograph it starts at.

When a change does more than you asked, the answer says so: taking out the cover or the opening photograph clears it, a new cover drops the old one's focal point, and moving or taking out the photograph a chapter starts at moves the chapter to the next photograph. A chapter can't lose its only photograph, and chapters stay in order.

The Series screen's **Work order** box lists the series Work shows, in order, with **Move up**, **Move down** and **Take off Work** on each, and **Put on Work** adds one at the end. Work order always keeps at least one series, and a published series needs a place in it before a publish. If Work order or the featured series still name a series the draft no longer holds, say one whose folder was removed by hand, the next change from the screen leaves it out and says so. **Featured on Home** has a box for each published series, and for any featured now. Each load of Home starts on one of the featured series a publish holds, at random, and plays through all of them: each from its opening photograph through its own order, then the next, in the order they're featured. Feature more than one for a different start on each visit. Only a published series can be featured, so the answer says when a publish would wait on that.

Every one of these writes the draft only, under the version the page loaded, as Save does: if the series, or Work order, changed since, or a publish or rollback happened, nothing is written and the page asks you to refresh. Nothing on the Series screen is public until you publish.

### Changing a slug

A series' slug is its address, `/work/<slug>`. Retitling a series never changes it, and nothing on the Series screen does: `photos edit ser_<name>` does ([README](../README.md#curating-the-catalog)). Links people saved or shared point at the old address, so a change keeps it. Add the old slug to `slugAliases` in the same edit, beside any old slugs already there. Say Harbor Nights was renamed once from `harbor` to `harbor-nights`, and now becomes `harbor-at-night`:

```json
"slug": "harbor-at-night",
"slugAliases": ["harbor", "harbor-nights"]
```

After the publish, `/work/harbor` and `/work/harbor-nights` both answer 308 to `/work/harbor-at-night`. A publish that changes a slug without keeping the old one, or drops an older one in the same edit, stops on `route.slug-change`, and Publish's blocker names the alias to keep.

An address stays with its series. While `/work/harbor` is live on Harbor Nights, no publish can give it to another series, as its slug or as an old address (`route.alias-reassigned`), since every link to Harbor Nights would land on that series instead. To move an address, take it off its series first, publish, then give it to the other series and publish again. A live slug comes off only through an alias, so for a slug that's three publishes: the rename with the old slug kept, then the old slug out of `slugAliases`, then the other series' edit. Between the last two, `/work/harbor` answers 404. Taking an old slug out of `slugAliases` breaks its links, and no check stops that, so do it on purpose.

Restoring a revision from before a rename puts its old addresses back, and drops any newer one it doesn't hold. A slug moved back to a series that has given it away does the same to the other series. History's Restore then asks you to accept the address change, such as "Accept Salt Roads' address: it changes from /work/salt-roads-west to /work/salt-roads without keeping the old one", and History shows it as "Accepted at restore: an address change that doesn't keep the old address." `photos rollback` asks for `--accept route.slug-change` or `--accept route.alias-reassigned`, and a scripted `photos rollback --yes` without them exits 1 and changes nothing. Both are accepts, not refusals: the revision is as sound as when it went live, and only what it does to today's addresses needs your word. `photos verify` doesn't run them, since they depend on which revision is live.

## Preview and publish

`/curation/publish` (#16) shows what the next publish changes for visitors, and publishes it. The change ledger lists every change in visitor terms, in two groups: Authored, which needs your judgment, and Derived, which the catalog works out. Before and after show where they help. A change that blocks the publish says **Blocks publishing** and carries its fix:

- A suggested description opens under its row, beside the photograph: **Mark description ready** marks those exact words reviewed. To change them, edit the item in the Inbox, or run the `photos edit` command the fix names.
- A review that went stale (the live revision changed, or the photograph got new bytes) or a change made by hand shows its before and after, and **Still right, mark reviewed** stamps exactly the value shown. Neither writes a value, and both refuse with nothing written when the value moved since the page loaded.
- A change whose Inbox item needs a decision again links to that item, with its `curation show` command beside it.
- A review that went stale because the live revision changed the field, or a field a restore left in conflict, also offers **Use the published value**: it puts the live value back into the draft, so the change leaves the ledger. For an order or the chapters it puts back the whole field, and says so. It refuses, with nothing written, when the record or the live revision moved since the page loaded, or the field's Inbox item needs a decision. `photos review --use-published <changeId>` is the same on the command line.

The ledger also lists each chapter change on its own row, and a series' derived row says how many other photographs a move shifts ("5 other photographs shift one place later"). A text change shows the words removed and added. A group of more than 50 rows starts collapsed, and a link to a row inside it opens it. While the page is open it checks again every minute, and when you come back to the tab: a change whose review went stale since the page loaded is announced, and **Base moved** says when another revision went live, with **Load the updated ledger** in place of Validate and Publish. It stops checking while the tab is hidden and after a couple of hours, and never sends a second check while one is waiting.

**Open full preview** has a toolbar: **Fit the window**, **Desktop** (1440 by 900) and **Mobile** (390 by 844), which change the frame's size only, scaled to fit, the draft's short hash, and **Back to Publish**.

Without the curator, `photos diff` lists the same rows on the command line, with their change IDs, and `photos review <changeId>...` is **Mark reviewed** and **Still right, mark reviewed**, and `photos review --use-published <changeId>` is **Use the published value**: the same code, the same refusals, against the candidate and the live revision `photos diff` printed. It never marks a suggested description ready, and it has no `--all` ([README](../README.md#reviewing-what-a-publish-changes)).

**Validate revision** runs every publish rule on the draft the page shows, as `photos publish --dry-run` does. **Publish revision N** unlocks once that passes, and runs the same publish as `photos publish`, for exactly the draft you previewed: if the working catalog changed after the page loaded, or someone published from the command line, nothing is published and the screen says so, with **Load the updated ledger**. While another publish or rollback holds the catalog, or a publish stops, Publish stays on as the retry. The panel shows the draft as visitors would see it, opened on the first changed photograph, and **Open full preview** opens it in a new tab. The preview's About shows the portrait from `./site-config`, which `curator` mounts read-only as `web` does, and loads it from the preview's own path, to a signed-in session only and never cached. With a compose file from before `v1.2.1`, which doesn't mount it, the preview's About shows the name instead ([releasing.md](releasing.md#abouts-portrait)).

While a draft is waiting, the panel's last line, "Last-known-good revision N remains rollback-ready.", means the live revision passes the checks a restore runs, its file, its rules, and its `/media` sets' sizes and manifests, and no `photos verify` has failed it. The screen runs those checks on every load. It doesn't hash the sets, which takes too long for a page load, so a file that changed but kept its size shows only once you run `photos verify` ([README](../README.md#verify)), which nothing runs on its own. On any sign of a problem a warning in the alert tone takes the line's place, and Validate's answer says the same in place of "Revision N stays rollback-ready.": "Revision N failed its last check, so it isn't rollback-ready." when the last `photos verify` failed it, even one run while another revision was live, "Revision N fails the checks a restore runs, so it isn't rollback-ready." when the screen's own checks fail, that the record of the last check can't be read, or that the activation records don't show the revision going live, when the active pointer names an activation no record holds or one set aside. Each ends with `photos verify`, which lists what fails and what to put back. For an unreadable record, running `photos verify` in the watcher's container writes it again. If it still can't be read, `status/` and `status/verify.json` have to belong to uid 1001, like the rest of the data root, which [data-root.md](data-root.md) covers. For the activation records, `photos verify` names the fix, and restoring a revision from History records a new activation. The warning stays until a `photos verify` passes the revision, or another one goes live. Neither the line nor the warning changes what Publish or Restore does.

Photos `photos carry-over` brought over at the launch have no description yet. The ledger says so ("No description yet, named by its place") as information, never as a blocker, and the site names each by its place in Gallery, "Photograph N of T", as the legacy Gallery did. A description you write replaces the name, and the usual review applies. Gallery has no statement until you write one ([releasing.md](releasing.md#carrying-todays-photos-over)).

### History and restore

**History**, last on the screen, lists every publish and restore, newest first, and says of each whether it can come back. **Restore revision N** opens a dialog that names the revision, shows what is live now and what visitors would see change, and asks why; the reason is saved with the new entry. Restoring makes the earlier revision live again as a new entry, through the same rollback as `photos rollback`; nothing is copied, renumbered or deleted, and the revision it replaces stays in History. If another revision goes live while the dialog is open, nothing is restored and the dialog says what went live. A revision that went live under older rules can carry something today's checks flag, such as an accent color that's hard to read on the Viewer's dark bands, and one from before a rename changes an address ([Changing a slug](#changing-a-slug)). Its dialog then has one checkbox for each, labelled in plain words, such as "Accept Salt Roads' accent color: it's hard to read on the Viewer's dark bands", and Restore stays unavailable until you check every one; pressing it before then says so and moves to the first box left. Each checked box is an accept the new entry records, and History shows it as "Accepted at restore: …". The server checks this too: a restore that arrives without every accept, however it was sent, restores nothing and says what is still to accept, and if the checks changed after the page loaded, such as after an upgrade, **Load the updated page** shows the current boxes. `photos rollback` asks the same with `--accept <ruleId>`. A revision whose last `photos verify` failed, or every revision while that record can't be read, shows no Restore: its entry says so and to run `photos verify`. Only `photos rollback --accept verify.failed` brings it back anyway, and History then shows "Accepted at restore: a failed check from photos verify". A draft that's waiting stays: the screen then compares it against the restored revision, and a field both changed blocks the next publish until you settle it with `photos edit`. The screen shows the newest 10 entries, **Show 10 older entries** adds more, and `photos history` lists them all. Restores from the screen record `curator:web` as the actor. Each entry says when it ran and whether you ran it from this screen or from the command line, and the screen's answers say the same, "You published it from the command line at 14:05." or "You restored it from the command line at 14:05.", since you are the only one who publishes. `photos history` still lists the actor each command recorded.

## Who can reach it

By default, whoever can open port 3001 on the host's loopback and knows the curator's passphrase. Nobody else. [LAN mode](#from-your-home-network), which you turn on in `.env`, widens that to every device on your home network.

- `curator` publishes only on the host's `127.0.0.1:3001`, never on another interface, and it sits on a network of its own, so neither `web` nor any other container can reach it.
- From another machine, the way in is an SSH local port forward. Your SSH key, checked by the host's `sshd`, decides who reaches the port at all.

  ```bash
  ssh -L 3001:127.0.0.1:3001 <host>
  ```

  Then open `http://127.0.0.1:3001/curation` or `http://localhost:3001/curation` on your machine.
- If 3001 is taken on your machine, forward another local port and tell the curator about it with `CURATOR_TUNNEL_PORT` (see below), say `ssh -L 4011:127.0.0.1:3001 <host>` with `CURATOR_TUNNEL_PORT=4011` in the `.env` next to `docker-compose.prod.yml`. The forward's far end stays `127.0.0.1:3001`, or the LAN address in [LAN mode](#from-your-home-network).
- Anyone with a shell on the host can reach the port too. Keep the host's accounts to the people you'd hand the curator to.
- Then the curator asks for its passphrase, which you set when you deploy it (below). The login is defense in depth on top of the tunnel, not a reason to open the port wider: never publish it on another interface, put it behind a public reverse proxy, or share it through a tunnel service.

## From your home network

LAN mode publishes the curator on the host's address on your home network, so you can curate from a laptop or tablet in the house without an SSH tunnel. It's off unless you turn it on, and with it off nothing above changes. The owner chose it on 2026-11-01, knowing the trade below.

Add two lines to the `.env` next to `docker-compose.prod.yml`, with the host's own LAN address:

```bash
CURATOR_PUBLISH=192.168.86.250
CURATOR_HOST_PORT=3001
```

Then recreate `curator` alone, and open `http://192.168.86.250:3001/curation/login` from another device on the network. Every command in this guide takes both files, `-f docker-compose.prod.yml -f <override>`, as [releasing.md](releasing.md#deploying) says; without an override, leave out `-f <override>`. With releasing.md's symlink layout, plain `docker compose` loads both:

```bash
docker compose -f docker-compose.prod.yml -f <override> --profile curator up -d --no-deps curator
```

`CURATOR_HOST_PORT` is optional and defaults to 3001. If something else on the host has 3001, pick a free port, say `CURATOR_HOST_PORT=3011`, and open `http://192.168.86.250:3011/curation/login` instead. `web` and the watcher don't read either line.

**Who can reach it.** Every device on that network can open the sign-in page: your own, and anyone else's that joins it, a guest's phone or a smart TV included. They still need the passphrase, and the lockout, the `Host` allowlist, the `Origin` check and the session work as before. Nothing outside your network can reach it, as long as your router doesn't forward the port. That's the boundary in LAN mode.

- **It's plain http.** The passphrase and the session cookie cross your network unencrypted. Anyone on it who watches the traffic, from a compromised device or on an open Wi-Fi, can read the passphrase as you sign in and copy the cookie. The login page says so, in one line above the form. So the cookie drops `Secure` for the LAN names over http, or the browser wouldn't keep it; it keeps `HttpOnly`, `SameSite=Strict` and its 12 hours. On `127.0.0.1` and `localhost`, and over https, it keeps `Secure` as before.
- **Don't forward this port on your router,** and don't put it behind a public reverse proxy or a tunnel service. With a forward, anyone on the internet gets the sign-in page, over plain http.
- **Use the LAN address, never `0.0.0.0`.** `0.0.0.0` publishes on every interface the host has, its public one included if it has one. The curator refuses it: with `CURATOR_PUBLISH` set to anything but `127.0.0.1`, `localhost`, `::1` or a private address (10/8, 172.16/12, 192.168/16, 169.254/16, `fc00::/7`, `fe80::/10`), it logs which setting is wrong and stops, and answers 503 on every path, the login page included, until it does. An IPv6 address goes in brackets, such as `CURATOR_PUBLISH=[fd00::5]`, so Compose can read the publish.
- **Publish it with `CURATOR_PUBLISH` only.** Publishing the curator from an override file instead isn't supported. In loopback mode the curator can't see a wider publish, and any caller can send `Host: localhost:3001`, so the allowlist would let them in.
- **No rule on the caller's address.** The curator doesn't check that a request comes from a private address. Next gives its request handling no socket peer address, and `X-Forwarded-For` is whatever the caller sent, so a check on it would only look like one. The publish on the LAN address and your router are what keep the internet out.
- **The lockout is shared.** It's one lock for the whole curator, not one per device, since the curator can't tell callers apart (above). Five wrong tries within 15 minutes, from any device on your network, lock every device out, yours included, for 15 minutes. A restart of `curator` clears it:

  ```bash
  docker compose -f docker-compose.prod.yml -f <override> --profile curator restart curator
  ```
- **Keep the host's address fixed.** `CURATOR_PUBLISH` names one address, and most home routers hand addresses out by DHCP. If the host gets another one, Docker can't publish on an address the host no longer has, so `curator` fails to start until `.env` matches again. Give the host a DHCP reservation on your router, or a static address, before you turn LAN mode on. If the address does change, set `CURATOR_PUBLISH` to the new one and recreate `curator` as above.
- **After a reboot it's off,** in LAN mode as in loopback mode. Its restart policy is `no`, so it runs only while you start it ([Turning it on and off](#turning-it-on-and-off)). Start it again with the same command, and `.env`'s settings still apply:

  ```bash
  docker compose -f docker-compose.prod.yml -f <override> --profile curator up -d --no-deps curator
  ```
- **An SSH tunnel goes to the LAN address.** In LAN mode nothing listens on the host's `127.0.0.1:3001`, so a forward to it gets no answer. Point the far end at the LAN address instead, then open `http://127.0.0.1:3001/curation` on your machine as before. The curator still answers to `127.0.0.1` and `localhost`, and the cookie keeps `Secure` there:

  ```bash
  ssh -L 3001:192.168.86.250:3001 <host>
  ```

**More names.** The curator answers to `<CURATOR_PUBLISH>:<CURATOR_HOST_PORT>`, and to `127.0.0.1` and `localhost` for the healthcheck and an SSH tunnel. To open it by a name your network resolves, such as the host's mDNS name, list it with its port in `CURATOR_EXTRA_HOSTS`, comma-separated:

```bash
CURATOR_EXTRA_HOSTS=homelab.local:3001
```

Each entry is a hostname, an IPv4 address or a bracketed IPv6 address, then `:` and the port, with no wildcards. Any other `Host` answers 421, which keeps a site that points its own name at your host (DNS rebinding) out. The setting is read in LAN mode only, and one entry that doesn't parse is a 503 on every path, like a bad `CURATOR_PUBLISH`.

**Turning it off.** Remove the `CURATOR_PUBLISH`, `CURATOR_HOST_PORT` and `CURATOR_EXTRA_HOSTS` lines from `.env`, and recreate `curator` the same way:

```bash
docker compose -f docker-compose.prod.yml -f <override> --profile curator up -d --no-deps curator
```

It's back on `127.0.0.1:3001`, with `Secure` on every cookie. A session from LAN mode doesn't carry over: sign in again through the tunnel.

**The stronger option: https on the LAN.** Put a TLS proxy on the host in front of the curator, with a certificate from a local certificate authority you install on each of your devices. It encrypts the passphrase and the cookie, and the cookie keeps `Secure`, at the cost of that certificate setup on every device. Run the proxy on its own port, say `homelab.local:3443`, forwarding to `http://192.168.86.250:3001`. It has to pass the browser's `Host` on unchanged and send `X-Forwarded-Proto: https`, which most proxies do by default. List that name in `CURATOR_EXTRA_HOSTS=homelab.local:3443`, and open `https://homelab.local:3443/curation/login`. On a name in LAN mode, the `Origin` check takes `https` as well as `http`, still for the same host and port as `Host`, and an `https` Origin with no port counts as 443. A proxy on 443 works too: list `homelab.local:443`. The browser then sends `Host: homelab.local` with no port, and on a LAN name the curator reads that as 443 when the first `X-Forwarded-Proto` is `https`, and as 80 otherwise. The plain http port stays open on the network beside it, so sign in only on the https name.

Every curator page, route handler and server action runs `requireCurator()` (`lib/curation/auth/index.ts`) first. It checks the flag, then the `Host`, then the `Origin` on anything that changes state, then a live session. Only the login page and its form skip the session.

## The login credential

The owner chose this on 2026-10-25: "Allow user to define a login credential at deployment time." The credential is two files you make on the host when you deploy, under `./secrets/` next to `docker-compose.prod.yml`:

| File | What it is |
|------|------------|
| `secrets/curator-passphrase.hash` | The scrypt hash of the passphrase (`N=32768, r=8, p=1`, a salt of its own), one line. Never the passphrase itself. |
| `secrets/curator-session.key` | 32 random bytes that sign the session cookie. |

Both belong to uid 1001, the user `curator` runs as, with mode `0400`, so only it can read them. The folder is `0700`, owned by uid 1001 too. They never go in git (`secrets/` is in `.gitignore`), the image (`.dockerignore`), Compose values or the environment: `curator` mounts `./secrets` read-only at `/run/secrets/curator`, and no other service mounts it. `ci/check-compose.sh` fails a Compose file that mounts it anywhere else or sets a secret in an environment.

### Making them

Run this once, from the folder that holds `docker-compose.prod.yml`, with `PHOTOGRAPHY_IMAGE_TAG` set to the release you run. The commands run in the release image as uid 1001, with no network, so the files come out owned by uid 1001 and `0400`:

```bash
sudo install -d -m 0700 -o 1001 -g 1001 secrets
docker run --rm -it --network none --user 1001:1001 -v "$PWD/secrets:/secrets" \
  ghcr.io/keyurgolani/keyurgolani.photography:"$PHOTOGRAPHY_IMAGE_TAG" \
  node dist/scripts/photos.mjs curation hash-passphrase --out /secrets/curator-passphrase.hash
docker run --rm --network none --user 1001:1001 -v "$PWD/secrets:/secrets" \
  ghcr.io/keyurgolani/keyurgolani.photography:"$PHOTOGRAPHY_IMAGE_TAG" \
  node dist/scripts/photos.mjs curation session-secret --out /secrets/curator-session.key
sudo ls -ln secrets
```

`hash-passphrase` asks for the passphrase twice with echo off, refuses one under 12 characters, and writes only the hash. It prints no passphrase, hash or path. Choose a long passphrase you don't use anywhere else: the lockout below slows guessing, but it doesn't stop it. Piped instead of typed (`-i` in place of `-it`), it takes stdin with one trailing line break dropped, which keeps the passphrase in your shell's history if you type it into the command, so prefer the prompt. The last line should list both files as `-r--------` and owned by `1001 1001`.

### Rotating them

Make new ones the same way (each command replaces its file in one rename) and restart the curator (without an override, leave out `-f <override>`):

```bash
docker compose -f docker-compose.prod.yml -f <override> restart curator
```

A new passphrase hash counts from the next login. A new session secret, or any restart, ends every session. The files need no backup: if they're lost, make new ones.

### When one is missing

With `CURATION_ENABLED=true` and a secret file missing, unreadable, readable by anyone but its owner, or not one these commands wrote, the curator answers 503 on every path `proxy.ts` sees, the login page and `/api/health` included (Next's own `/_next/static` and `/_next/image` aren't curator content), and logs which setting is wrong, never a value. The 503 is one small page, the same on every path: it names those four causes and points to the log and this section, without naming the file (`lib/curation/auth/unavailable.ts`). It never runs without them. Without the `secrets` folder at all, Docker won't start `curator`. With the flag off, the curator paths are 404 as always.

## Signing in

Open `http://127.0.0.1:3001/curation` (or `localhost`) through the tunnel, in Chrome or Firefox (Safari may not keep the session on `http://localhost`; see The cookie, below). Without a session, it sends you to `/curation/login`. Enter the passphrase, and you're back at `/curation`. Pick one of the two names and keep to it: your password manager files the passphrase per name (under the username `curator`, which the page supplies), and a session on one name doesn't count on the other.

The login page says what happened last: a wrong passphrase, the lock, "You're signed out." after Sign out, or "Your session ended. Sign in again." when the browser sent a session cookie that no longer counts, after a restart or a new session secret. (The 12-hour end takes the cookie out of the browser too, so that one lands on the plain page.)

- **Sessions.** A login starts a new session, a random 32-byte ID the curator keeps in its memory, and ends any session the browser had. It lasts 12 hours, then you sign in again. **Sign out** (a POST) ends it at once: the curator deletes it, so a copy of the cookie is worth nothing after. A restart of `curator` ends every session, which is fine: sign in again.
- **The cookie.** `curator_session` holds the session ID and an HMAC-SHA256 tag of it under the session secret. It's `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/` and `Max-Age=43200`, and in [LAN mode](#from-your-home-network) the same without `Secure` on a LAN name over plain http. Chromium and Firefox keep `Secure` cookies on `http://localhost` and `http://127.0.0.1`, which is what the tunnel serves (`e2e/curator-login.spec.ts` checks both). WebKit on Linux drops one on both, and Safari may too, so over the SSH tunnel sign in with Chrome or Firefox: Safari may not keep the session on `http://localhost` or `http://127.0.0.1`. Cookies are kept by host name, not port, so other servers on your own machine's `localhost` get the cookie too; sign out when you're done.
- **The lockout.** Five failed logins within 15 minutes lock login for 15 minutes. It's one lock for the whole curator, not one per client: every request comes over loopback, so every client looks the same, and whatever else a client sends to tell itself apart is the client's to change. While it's on, the right passphrase is refused too, with the same answer as a wrong one, and the login page says only that the lock is on, about how many minutes it has left, and that a restart ends it. Someone who can reach the port can keep you locked out; that is someone who already has the host or your tunnel, or in LAN mode anyone on your network. A restart of `curator` clears the lock.

## Turning it on and off

`curator` belongs to a Compose profile of its own, so `docker compose up -d` never starts it. Make [the login credential](#the-login-credential) first. Then start it by name when you need it, and stop it when you're done. Without an override, leave out `-f <override>`, or use plain `docker compose` with releasing.md's symlink layout:

```bash
docker compose -f docker-compose.prod.yml -f <override> --profile curator up -d --no-deps curator
docker compose -f docker-compose.prod.yml -f <override> stop curator
```

Its restart policy is `no`, so a reboot or a Docker restart leaves it off. It mounts no library, since it reads no file there, only the registry and the `/media` sets, and sets `PHOTOGRAPHY_LIBRARY_DIR=/data/library` only to keep that path out of its messages. It writes the data root and runs as uid 1001, the watcher's, so the data root setup in [data-root.md](data-root.md) covers it too. Its Inbox, Publish and Restore write `authored/`, `catalog/`, `locks/` and `curation/events/` there, so stop it with the watcher whenever the data root has to hold still: [Backing up](data-root.md#backing-up), [Restoring](data-root.md#restoring) and [Editing a document by hand](data-root.md#editing-a-document-by-hand) say how.

## What keeps it private

Each of these holds on its own. `proxy.ts` checks the first six on every request, and `requireCurator()` checks them again (`lib/curation/auth/policy.ts`).

- **The flag.** `CURATION_ENABLED` turns the curator on, and only the exact value `true` does. It's read on every request, never at build time, so the one image serves both. While it's off, every curator path answers 404. Only `curator` sets it; `web` never does, and CI fails a Compose file that sets it anywhere else.
- **The bind.** With the flag on, a server told to listen beyond loopback stops at startup with a message, and refuses every curator request until it exits. See the rule below.
- **The `Host` allowlist.** With the flag on, every request `proxy.ts` sees on the curator process, its public paths included, needs `Host: 127.0.0.1:3001` or `localhost:3001`, or the same names on `CURATOR_HOST_PORT` or `CURATOR_TUNNEL_PORT`, or in [LAN mode](#from-your-home-network) one of its LAN names. Any other answers 421. That turns away a page that points its own domain name at `127.0.0.1` (DNS rebinding). The service's healthcheck sends `Host: localhost:3001` for the same reason. Next's build files under `/_next/static` don't pass through `proxy.ts`, and `/_next/image` passes through it only for its `url` check, so both answer any `Host`. They're the same bytes `web` serves to anyone.
- **The `Origin` check.** Anything that can change state (every method but GET and HEAD, and every server action) also needs an `Origin` naming the same host and port as the `Host` the request came on, over `http`, or in LAN mode over `https` too on a LAN name. Anything else answers 403. That turns away a form or script on another site posting to the curator through your open tunnel. Login and logout are POSTs, so they need it too.
- **The session.** Every curator path but the login page and its form needs a live session. Without one, a page and its RSC fetch go to `/curation/login` (a 307), and a route handler or a server action answers 401.
- **The secret files.** With either one missing or unusable, every path `proxy.ts` sees answers 503.
- **The headers.** Every curator response sends `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, and `Content-Security-Policy: frame-ancestors 'none'`, and every curator page renders per request.
- **Read-only everywhere else.** Outside the curator paths the site takes only GET, HEAD and OPTIONS, so a server action posted to `/` answers 404. `web` mounts the data root read-only and no library at all, and `/media` serves only what the active catalog revision holds.

### The bind rule

With `CURATION_ENABLED=true`, the server checks where it listens, twice.

1. The address it was told: `--hostname` (or `-H`) when `next start` runs it, and `HOSTNAME` otherwise, which the standalone `server.js` reads. It must be `127.0.0.1`, `::1` or `localhost`. An unset one counts as every interface, since that's what both servers do without it. `npm start` already passes `--hostname 127.0.0.1`.
2. The socket it actually listens on, once it does. Every one must be on loopback, whatever the settings said. Under `next dev`, whose server runs in a child process that gets `--hostname` over IPC, the socket is the only check, and a dev server whose socket can't be read stops. `npm run dev` already passes `--hostname 127.0.0.1`, so this just works:

```bash
CURATION_ENABLED=true \
  CURATOR_PASSPHRASE_HASH_FILE=secrets/curator-passphrase.hash \
  CURATOR_SESSION_SECRET_FILE=secrets/curator-session.key \
  npm run dev
```

For that, make test files with `npx tsx scripts/photos.ts curation hash-passphrase --out secrets/curator-passphrase.hash` and `npx tsx scripts/photos.ts curation session-secret --out secrets/curator-session.key`, with a passphrase you use nowhere else.

The one exception is the `curator` service. Docker's port forward reaches a container on its own network interface, so inside the container the server has to listen on every interface, and the publish to the host's `127.0.0.1` is the boundary. The service sets `HOSTNAME=0.0.0.0` with `CURATION_BIND_SCOPE=container`, which accepts `0.0.0.0` or `::` and nothing else, only where Docker's or Podman's container marker file exists, and only while the process sees one network interface beyond loopback. Outside a container, that setting stops the server. CI checks that `curator` is the only service with it, that its one published port is `127.0.0.1:3001` with nothing set (in LAN mode, the address `CURATOR_PUBLISH` names), that only `curator` reads the LAN mode settings, and that it shares no network with another service.

The exception assumes the container has a network of its own. Never run the curator with the host's network (`network_mode: host`, `docker run --network host`, Kubernetes `hostNetwork`, or a toolbox or distrobox container): there `0.0.0.0` is every interface of the host. CI rejects `network_mode` on `curator`. The one-interface check stops it on a host with more than one active interface, such as the production host while `web` runs. It can't catch host networking on a host with one active interface, such as one network card and an idle Docker bridge, since an idle bridge doesn't count. Neither check covers a container started outside this Compose file.

## Settings

| Variable | Set on | What it does |
|----------|--------|--------------|
| `CURATION_ENABLED` | `curator` only | `true` turns the curator on. Anything else, or unset, keeps every curator path a 404. |
| `CURATOR_TUNNEL_PORT` | `.env`, read by `curator` only, optional | One more local port the `Host` allowlist answers to, for a tunnel that doesn't use 3001 on your machine. A value that isn't a port from 1 to 65535 stops the server. |
| `CURATOR_PUBLISH` | `.env`, read by Compose and `curator` only, optional | Unset, `127.0.0.1`, `localhost` or `::1`: the publish on the host's loopback, as always. A private address of the host: [LAN mode](#from-your-home-network). Anything else, `0.0.0.0` included, stops the server and answers 503 on every path. |
| `CURATOR_HOST_PORT` | `.env`, read by Compose and `curator` only, optional | The host port `curator` publishes on, 3001 when unset. The `Host` allowlist answers to it too. A value that isn't a port from 1 to 65535 stops the server. |
| `CURATOR_EXTRA_HOSTS` | `.env`, read by `curator` in LAN mode only, optional | More `name:port` Hosts the curator answers to, comma-separated, such as `homelab.local:3001`. No wildcards. One that doesn't parse stops the server. |
| `CURATION_BIND_SCOPE` | `curator` only | `container` lets the curator listen on every interface inside its container. Anything but `container` or unset stops the server. |
| `CURATOR_PASSPHRASE_HASH_FILE` | never in Compose | Where the passphrase hash is. Defaults to `/run/secrets/curator/curator-passphrase.hash`, where `curator` mounts it. For a curator run outside Compose, such as `next dev`. |
| `CURATOR_SESSION_SECRET_FILE` | never in Compose | Where the session secret is. Defaults to `/run/secrets/curator/curator-session.key`. |
