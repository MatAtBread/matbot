# @matatbread/matbot-browser

This is a [matbot](https://github.com/MatAtBread/matbot) plugin.

Browser-native building blocks: an IndexedDB `Store`, an OPFS `FileStore`, WebCrypto- and
localStorage-backed vaults, and the browser `plugin` and `provider` tools. The web bundle boots on
them; loaded as a plugin, it makes the IndexedDB + OPFS backend nameable, so it can be asserted over
another backend.
