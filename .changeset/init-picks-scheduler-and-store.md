---
'@datafridge/cloudflare': minor
---

`datafridge init` takes the scheduler and the store as separate choices, and writes only what that combination needs.

```sh
datafridge init --scheduler durable-object --store d1
datafridge init --scheduler cron --store d1
```

It used to scaffold both schedulers and tell you to delete the one you were not using. Generated configuration you have to prune is not a starting point, and it contradicted the rest of the library: the pieces compose freely, so `init` should not hand out a fixed pairing. Both flags are required - there is no default - and an unknown value is refused with the list of supported ones rather than guessed at.
