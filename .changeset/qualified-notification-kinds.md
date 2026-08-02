---
'@matatbread/matbot-plugin-api': patch
'@matatbread/matbot-core': patch
'@matatbread/matbot-frontend-web': patch
'@matatbread/matbot-skills': patch
'@matatbread/matbot-workspace': patch
'@matatbread/matbot-background': patch
'@matatbread/matbot-storage-profiles': patch
'@matatbread/matbot-tool-router': patch
'@matatbread/matbot-tool-types': patch
---

**Breaking (wire + types): a notification `kind` is now `<package-name>#<InterfaceName>`.**
`'store-change'` → `'@matatbread/matbot-plugin-api#ItemChange'`, `'registry'` →
`'@matatbread/matbot-plugin-api#RegistryChange'`, with the interfaces renamed to `ItemChange` /
`RegistryChange` to match. A `kind` is globally scoped and, unlike a type name, an importer cannot
rename it out of a collision — two plugins picking the same bare word is an unfixable
declaration-merge conflict, and across a bridge a silent mis-narrowing. Qualifying by package name
(already unique) removes both. `ItemChangeKind` / `RegistryChangeKind` are exported so consumers
get a renameable handle back.

An arm no longer declares `kind` at all: `NotificationBase` drops the field and `Notification`
grafts each arm's `Notifications` key on, so the tag cannot disagree with the key it is registered
under. `NotifyInput` rejects an unqualified key at the `notify` call, and `createNotifier` warns at
runtime for producers TypeScript never saw (plain JS, a bridge).

`StoreChangeNotification` becomes `ItemChange` — named for its contract rather than a medium. It was
already a misnomer at two of five emitters (a `FileStore` write; a share/unshare passing through no
`Store`), and the mechanism-flavoured name made "is my thing a Store?" the first question a plugin
author had to answer. Publish `ItemChange` for any invalidation of an item addressed by
`(namespace, id)`, whatever holds it; define your own kind only when you carry something a consumer
cannot get by re-reading.

Also removes the unused pre-bus `StoreChange` envelope from `types.ts`, which the notification arm
duplicated.
