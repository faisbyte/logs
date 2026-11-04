# Dashboard design

The logs dashboard (`apps/web`) uses the showcase site's design language (logs-website, `docs/design-notes.md` there), adapted for a tool people use daily.

## Carried over unchanged

- **Tokens:** the site's CSS variables, copied as they are: near-black with a faint green tint in dark mode, warm paper white in light mode, 1px hairlines, and no gradients, glows or imagery.
- **Three type voices:** Geist for prose and UI, Geist Mono for anything the machine says (commands, ids, labels, numbers, dates), and Newsreader only for the rendered stakeholder digest. They're self-hosted through `next/font`.
- **One meaning per accent:** green is approved or safe, amber is a pitfall, a warning or something that needs attention, blue is a decision, violet is a convention. Every status pill, context item and badge uses this mapping (`status-pill.tsx`).
- **Terminal panels stay dark in both themes.** The context brief always renders in one.
- **Section openings:** a mono label (`01 / DIGESTS`), a plain heading, and one short line.
- **Theme:** dark by default, with a remembered system, light or dark toggle, set before first paint.
- **Candour:** empty states say so ("No digests yet."), coverage lines are shown as the server wrote them, corrected and withdrawn digests are marked, and nothing is invented to fill space.

## Adapted, and why

- **Density:** tables, not cards, wherever people scan, such as the digest list. Under 40rem a table row stacks into labelled lines, so nothing scrolls sideways at 360px.
- **Motion:** none decorative and nothing tied to scroll. Motion is kept for state, such as a row arriving (`.row-arrive`) or a status changing. All of it switches off under `prefers-reduced-motion`.
- **Sizes:** headings are smaller than the site's marketing scale, because each page is something to work in, not a pitch.
- **Pills are outlined, not filled.** The accent colours the text, dot and border, which keeps every pair at WCAG AA on both themes. axe checks this on every view.
- **Print:** printing or saving as PDF sets the digest on light paper in the serif, without the app's chrome.
- **No hero, no marketing sections, no footer credits.** The site sells the idea. The dashboard is the work.
