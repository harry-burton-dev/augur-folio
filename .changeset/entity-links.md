---
'@apps/folio': patch
---

Artifacts' manifest says it binds records to entities (`links.entities`, `bindings: ["record"]`, SDK 2.1), so Data Atlas finds its binding events through the registry rather than a list in its own code. It needs AUGUR 0.22.0 or later, whose registry reads these fields.
