---
"@apps/folio": patch
---

The manifest's SDK range also accepts SDK 2. SDK 2 only stops serving Lit, which this app never used, so the
app keeps opening when a deployment moves to an AUGUR shell built on SDK 2.
