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
2. Build `cards.json`:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\build-cards.ps1
   ```
   The script lists any names Scryfall didn't recognise. Fix them and re-run.

> If you change the card list while people are submitting, existing picks are kept. Cards that were removed still show in people's lists, just without an image.

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

## Files
| File | What it is |
|---|---|
| `index.html`, `app.js`, `styles.css` | The picker page |
| `config.js` | Supabase URL, key and page title |
| `cards.txt` → `cards.json` | Your card list → card data from Scryfall |
| `scripts/build-cards.ps1` | Builds `cards.json` |
| `scripts/serve.ps1` | Local test server |
| `supabase/schema.sql` | Database tables, access rules and the results view |
