# The logo face

The wordmark is set in **Bowlby One** by vernon adams, under the SIL Open Font
Licence 1.1 (`OFL-BowlbyOne.txt` beside it). It is committed here as a WOFF2
rather than pulled from a CDN, because this runs off a laptop on conference
Wi-Fi with a headset next to it — an outbound request to fetch the logo is a
request that can fail at the worst moment.

`RubikMonoOne-Regular.woff2` sits here too, with its licence, as the
alternative: squarer, more technical, less 1970s. Swap the `src` in the
`@font-face` at the top of `src/ui.css` to try it.

## The face this actually wants

Capitalics' [Ping Pong](https://capitalics.wtf/en/font/ping-pong) — drawn by
Elżbieta Krużyńska in 1974, digitised by Mateusz Machalski and Małgorzata
Bartosik in 2020. It is free of charge but account-gated, so it cannot ship in
a public repository; it has to be fetched by a person who has agreed to the
licence. To use it instead:

1. Sign in at the link above and download it.
2. Check the licence covers what you are doing — a hackathon demo and a public
   deployment are not the same thing, and the product page states no terms.
3. Convert to WOFF2 (`fonttools`: set `font.flavor = 'woff2'` and save) and
   drop it here.
4. Point the `@font-face` `src` in `src/ui.css` at it.

Bowlby is standing in for it on purpose: same idea, heavy and geometric with
circular bowls, unmistakably of that decade — and redistributable.
