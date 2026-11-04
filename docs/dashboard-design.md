# Dashboard design

The logs dashboard (`apps/web`) uses the showcase site's design language (logs-website, `docs/design-notes.md` there), adapted for a tool people use daily.

## Carried over unchanged

- **Tokens:** the site's CSS variables, copied as they are: near-black with a faint green tint in dark mode, warm paper white in light mode, 1px hairlines, and no gradients, glows or imagery.
- **Three type voices:** Geist for prose and UI, Geist Mono for anything the machine says (commands, ids, labels, numbers, dates), and Newsreader only for the rendered stakeholder digest. They're self-hosted through `next/font`.
- **One meaning per accent, stricter than on the site:** green is approved or safe, amber is a pitfall, a warning or something that needs attention, blue is a decision, violet is a convention. Every status pill, context item and badge uses this mapping (`status-pill.tsx`). Ticket keys, section numbers, the wordmark's prompt, buttons, links, focus rings and text selection are neutral. A test (`accent-usage.test.ts`) scans the source so an accent can't drift into another meaning.
- **Terminal panels stay dark in both themes.** The context brief always renders in one.
- **Section openings:** a mono label (`01 / DIGESTS`), a plain heading, and one short line.
- **Theme:** readers follow their system theme by default and developers start dark. Anyone's choice on the system, light or dark toggle is remembered, and the theme is set before first paint.
- **Candour:** empty states say so ("No digests yet."), coverage lines are shown as the server wrote them, corrected and withdrawn digests are marked, and nothing is invented to fill space.

## Adapted, and why

- **Density:** tables, not cards, wherever people scan, such as the digest list. Each row is a single link, with hover and keyboard focus shown on the whole row. Under 40rem a row stacks into labelled lines, so nothing scrolls sideways at 360px.
- **Motion:** none decorative and nothing tied to scroll. Motion is kept for state, such as a row arriving (`.row-arrive`) or a status changing. All of it switches off under `prefers-reduced-motion`.
- **Sizes:** headings are smaller than the site's marketing scale, because each page is something to work in, not a pitch.
- **Pills are outlined, not filled.** The accent colours the text, dot and border, which keeps every pair at WCAG AA on both themes. axe checks this on every view.
- **Reading the digest:** one centred column, with the back link and the print button aligned to it. Small markers sit on "Key decisions" (blue) and "Risks and open questions" (amber), like a memo's margin notes. Under 640px the card falls away so the text uses the full width, and combined ticket headings put one ticket per line.
- **Print:** printing or saving as PDF sets the digest on light paper in the serif, without the app's chrome.
- **No hero, no marketing sections, no footer credits.** The site sells the idea. The dashboard is the work.

## Terminology

One user-facing term per concept, in every view. The labels live in `apps/web/src/lib/terms.ts`, and
`terminology.test.ts` fails if a view writes one itself or uses a synonym. Internal field names are unchanged. The CLI
keeps its own wording.

| Concept | Internal name | Shown as | Where |
|---|---|---|---|
| An approach a session tried, then dropped | `rejectedApproaches` | Tried and dropped | Ticket timeline, digest |
| The context item distilled from one | `type: 'pitfall'` | Pitfall | Context view, agent brief |
| A summary's decisions | `decisions` | Decisions (the digest picks "Key decisions") | Ticket timeline, digest |
| The context item distilled from one | `type: 'decision'` | Decision | Context view, agent brief |
| A way the team does things | `type: 'convention'` | Convention | Context view, agent brief |
| A summary's risks and next steps | `risksOrFollowUps` | Follow-ups (the digest combines them into "Risks and open questions") | Ticket timeline, digest |
| A summary the developer changed before approving | `editedByDeveloper: true` | Edited by developer (neutral) | Ticket timeline |
| A summary approved by the auto-approve setting | `approvedBy: 'auto'` | Auto-approved (amber: nobody read it first) | Ticket timeline |
| Approved by its developer, unedited | `approvedBy: 'developer'` | Nothing: every entry is approved | Ticket timeline |
| Context item states | `active`, `superseded`, `retired` | Active, Superseded, Retired | Context view |
| A summary taken back after sharing | retraction, `retiredBy: 'retraction'` | "withdrew a summary"; "Retired: its summary was withdrawn" | Digest, context view |
| A digest a withdrawn summary was in | `status: 'withdrawn'` | Withdrawn | Digest archive |

"Pitfall" never appears in the timeline or the digest, and "Tried and dropped" never appears in the context view. The text of
a context item is written by the model and is left as it is.
