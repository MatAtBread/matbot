# @matatbread/matbot-tool-docker-bash

This is a [matbot](https://github.com/MatAtBread/matbot) plugin.

Replaces the bash tool with a persistent Docker container (exec-based). Project root is read-only at /app; .data is read-write, except `.data/settings` and any SQLite database
files (`*.db`, `-wal`, `-shm`), which are mounted read-only over it. Those hold the permission gates' stored
answers, and a container that could write them could grant itself every later gate. The project's `.env`
is covered by `/dev/null`, so it reads as empty: it is the vault's file, and every secret is in it. A
container created with a different set of these mounts, including one from before these rules, is replaced
on its next use.
