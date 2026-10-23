# Rare Draft Picks

A static web page where people choose Magic cards from your list and rank them by priority. Each person ranks as many cards as they want (#1 = want most). They can add the same card more than once to ask for extra copies, and they can edit their picks until a deadline. Only you can see the results.

- **Frontend:** plain HTML/JS hosted on GitHub Pages. There's no build step.
- **Backend:** Supabase (free tier). The page can only call four locked-down functions. Nobody can read anyone else's picks.
- **Identity:** a person enters their name and gets a private **edit link**. Opening it on any device loads their picks.

## One-time setup

### 1. Supabase
1. Create a free project at <https://supabase.com>.
2. Open **SQL Editor**, paste in all of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
3. Go to **Project Settings → API** (or **API Keys**) and copy the **Project URL** and the **anon** / **publishable** key into [`config.js`](config.js). Never use the `service_role` / secret key.

### 2. Card list
1. Put your cards in `cards.txt`, one per line. You can pin a printing with `Name (SET)` or `Name (SET) 123`.
   - **Quantities:** for more than one copy of a card, repeat the line or put a count in front (`3 Lightning Bolt` or `3x Lightning Bolt`). The page shows "3 available", and each person can rank that card at most 3 times. This limit is enforced by the page only, not the database.
2. Build `cards.json`:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\build-cards.ps1
   ```
   The script lists any names Scryfall didn't recognise. Fix them and re-run.

> If you change the card list while people are submitting, existing picks are kept. Cards that were removed still show in people's lists, just without an image. If you lower a card's quantity, the next time someone opens their list the page drops their lowest-ranked extra copies and asks them to save.

### 3. Set the deadline
In the SQL Editor:
```sql
update settings set deadline = '2026-11-15 20:00 America/New_York' where id = 1;
-- remove the deadline:  update settings set deadline = null where id = 1;
```
The database enforces the deadline, so changing the clock on someone's computer can't get around it.

### 4. Test locally
```powershell
powershell -ExecutionPolicy Bypass -File scripts\serve.ps1
```
Then open <http://localhost:8080/>.

### 5. Publish on GitHub Pages
Push this folder to a GitHub repo. Then go to **Settings → Pages → Deploy from branch → main / root**. Share the resulting `https://<you>.github.io/<repo>/` link.

## Getting the results
- **All picks:** in Supabase go to **Table Editor → `picks_flat`** and choose **Export → CSV**. You get one row per person per rank, with columns `name, rank, card_name, updated_at, submission_id`. Use `submission_id` to tell apart two people who typed the same name.
- **Someone lost their edit link:** find them in the `submissions` table and send them `https://<your-site>/?t=<edit_token>`.
- **Quick tallies** in the SQL Editor:
  ```sql
  -- how many people asked for each card, and its best rank
  select card_name, count(distinct submission_id) people, count(*) copies, min(rank) best_rank
  from picks_flat group by card_name order by people desc, best_rank;
  ```

## Running the draft
Open `draft.html` (for example <http://localhost:8080/draft.html>, or `/draft.html` on your Pages site). It's for you only. It doesn't talk to Supabase, and everything is saved in that browser, so a refresh won't lose the draft.

1. **Load** the `picks_flat` CSV export (choose the file or drop it on the page). Each submission becomes a player with their ranked list.
2. **Optional: import from Google Sheet.** If ratings and pick counts live in a Google Sheet (one tab with names and a **Tokens** column, another with names and a **Rank** column), share it as *Anyone with the link can view*. Open each tab and paste its link (ending in `#gid=…`) into the two boxes, then click **Import from sheet**. The links are remembered on that browser. A review dialog matches sheet names to the submitted lists. Exact matches are ticked, close guesses ("Jamie R." ↔ "Jamie Robinson") are marked *check*, and anything unmatched becomes a new player with no list. Fix any wrong guesses and click **Apply**. Corrections are remembered, so a re-import matches straight away. Matched players take the sheet's spelling of their name.
3. **Set up players:** enter each player's **rating** (lower picks first) and how many **picks** they get, then click **Sort by rating**. Use ▲/▼ to break ties. **+ Add player** adds someone who didn't submit a list.
4. **Draft:** the page shows who's on the clock and their highest still-available cards (with each card's rank on their list), plus who's up next. Click their choice, or search **Other card…** for anything in the pool, then click **Confirm pick**. That copy is removed from everyone's lists.
   - The order snakes: when a round ends it reverses, so the last player picks twice in a row. Players who've used all their picks are skipped.
   - **Undo last pick** (or Ctrl+Z) takes back mistakes. **Players** lets you change pick counts mid-draft.
5. When every pick is made (or the pool is empty), the results page shows everyone's cards. **Export CSV** gives `pick_no, round, player, card, list_rank`.

**Reset draft** clears all picks but keeps the players, ratings and pick counts.

## Files
| File | What it is |
|---|---|
| `index.html`, `app.js`, `styles.css` | The picker page |
| `draft.html`, `draft.js`, `draft.css` | The live draft board (admin only) |
| `config.js` | Supabase URL, key and page title |
| `cards.txt` → `cards.json` | Your card list → card data from Scryfall |
| `scripts/build-cards.ps1` | Builds `cards.json` |
| `scripts/serve.ps1` | Local test server |
| `supabase/schema.sql` | Database tables, access rules and the results view |
