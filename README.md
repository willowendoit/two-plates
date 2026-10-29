# Two Plates

A protein-first recipe site for Will and Ella. 836 high-protein, healthy recipes from Mob, with ratings, favourites, quick picks and recommendations for each of you and for the two of you together.

## How it works

- `public/index.html` is the whole front end: one page, no build step.
- `netlify/functions/api.mts` is the API at `/api/*`:
  - `POST /api/login` checks the shared kitchen passcode and signs you in as Will or Ella (a signed cookie that lasts 180 days).
  - `GET /api/recipes` returns the recipe library (signed-in only).
  - `GET /api/state` returns both people's ratings, favourites, notes and cooking history.
  - `PUT /api/state` saves the signed-in person's own state. Each person only ever writes their own record, so you can't overwrite each other.
  - `POST /api/switch` and `POST /api/logout`.
- Ratings and history are stored in Netlify Blobs (store `two-plates`, keys `person/will` and `person/ella`).
- Recipe photos load from Mob's image host through Netlify Image CDN, which resizes and caches them (`[images]` in `netlify.toml`).
- `data/recipes.json` holds the recipe data: titles, nutrition per serving, ingredients and photo paths. Methods stay on Mob; each recipe links to its page there.

## Settings on Netlify

Two environment variables, scoped to Functions:

- `KITCHEN_PASSCODE`: the shared passcode. Change it in Netlify and redeploy to apply.
- `SESSION_SECRET`: a long random string used to sign the sign-in cookie. Changing it signs everyone out.

## Making changes

Push to `main` and Netlify deploys automatically.
