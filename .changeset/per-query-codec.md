---
'@datafridge/core': minor
---

A query can carry a codec.

```ts
{
  name: 'lesson-engagement',
  every: '15m',
  codec: {
    encode: (v) => ({ rows: [...v.byPath] }),
    decode: (raw) => ({ byPath: new Map(raw.rows) }),
  },
  fetch: ...,
}
```

Results are stored as plain JSON, so a fetched `Map`, `Set`, or `Date` used to need hand-rolled Serialized* wrapper types and conversions on both sides. `encode` runs on write, `decode` on read, and the wrapper types disappear. The stored row stays plain JSON, readable from any language; only a reader holding the query registry decodes, and a bare reader sees the encoded form. An `encode` that throws counts as a fetch failure and keeps the previous result.
