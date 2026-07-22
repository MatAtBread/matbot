# @matatbread/matbot-storage-profiles

## Unreleased

### Optional

- New plugin: a profile-aware `StorageBackend` that partitions selected namespaces (`sessions` by
  default) per web principal over the filesystem layout, with a `profile` CRUD tool. The default
  principal keeps the existing base layout, so existing sessions remain visible.
