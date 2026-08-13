---
'@matatbread/matbot-plugin-api': patch
'@matatbread/matbot-storage-profiles': patch
'@matatbread/matbot-frontend-web': patch
---

**Bug fix.** `url_for_resource` stamped a partition segment onto files that were in the shared base area.

It minted the `~<id>` prefix of a file URL from the identity in force, gated on the presence of the
`profile_action` tool — i.e. on "profiles are loaded", not on "these bytes went somewhere addressable".
A principal with no profile routes to the base area, so an ordinary file came back as
`/files/~matt/workspace/report.md`: a link that reads as partitioned, leaks the principal id into a URL
whose purpose is to be shared, and turns into a 404 the moment a profile of that name is created. The
inference was also unsound in the other direction, since a principal may hold several profiles and a
profile may alias its files onto another profile's area — the identity does not name the area at all.

**API gap filled.** New optional `MatbotServices` member `FilePartition`, registered by a backend that
partitions the file area (the profiles backend) and consumed by `frontend-web`:

```ts
interface FilePartition {
  current(): string | undefined;                          // the current file area, as an opaque token
  enter<T>(token: string, fn: () => Promise<T>): Promise<T>;  // its inverse
}
```

The address now comes from the router that placed the bytes, and the two halves are one round trip:
`GET /files/~<token>/…` resolves through `enter` instead of re-entering the token as a principal, which
was the same guess at the routing one layer up. Base answers `undefined`, so an unpartitioned deployment's
URLs are byte-identical to before.
