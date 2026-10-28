---
target: packages/chat-web/index.html
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:D:\\PROJETS\\ChaX\\packages\\chat-web\\index.html"
target_fingerprint: "sha256:01a8a2fca28ed4ed22d333051a3dfa67512731c7bff2c8e566ac0369ae4c7138"
target_path: "D:\\PROJETS\\ChaX\\packages\\chat-web\\index.html"
timestamp: 2026-10-28T11-00-15Z
slug: packages-chat-web-index-html
---
# Critique ChaX (index.html) — 28/40

Method: dual-agent. Detector: 0 findings (CLI + overlay). Contrast AA OK (entry screen only measured).

Scores: 1:3 2:3 3:3 4:3 5:3 6:2 7:3 8:3 9:2 10:3

Priority issues
- [P1] List re-sorts under the thumb (harden)
- [P1] Net dialog wall of text, globe unlabeled (clarify, layout)
- [P1] Header collision: nickname wraps, "mon code" clipped (layout)
- [P2] Delete actions no hierarchy; amber = brand+danger (polish, colorize)
- [P2] Low-contrast state layer dust-2 ~3:1 (audit)

Minor: dev version shows 0.2.1; overlay alpha .985; centered dialog text; no pseudo-editable hint.
