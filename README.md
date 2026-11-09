# Sweat Paddle Court booking system

The website can be hosted as static files on GitHub Pages. Shared courts, settings, and bookings are stored in a private Google Sheet. A Google Apps Script web app (included in `google-apps-script/Code.gs`) acts as the small API between the site and the sheet. Customers do not need a Google account. No Node server or separately paid database is required for this setup.

## One-time Google setup

1. Create a Google Sheet and keep its sharing set to **Restricted**. Copy the spreadsheet ID from its URL: the text between `/d/` and `/edit`.
2. Open **Extensions → Apps Script**. Replace the starter code with `google-apps-script/Code.gs` from this project.
3. In `Code.gs`, replace `PASTE_YOUR_GOOGLE_SHEET_ID_HERE` with the ID from step 1. Save.
4. In Apps Script, open **Project Settings → Script Properties** and add `ADMIN_SETUP_TOKEN` with a long, random value. Keep it private; you will enter it once when creating the site admin account.
5. Choose **Deploy → New deployment → Web app**. Set **Execute as** to **Me** and **Who has access** to **Anyone** (anonymous access). Do not choose an option that requires users to sign in. Authorize the script when Google prompts you.
6. Copy the deployed web app URL ending in `/exec` into `api-config.js`, replacing `PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE`.
7. Commit and push the site to GitHub, then enable GitHub Pages for the repository. Open the published site, select the admin icon, and create the admin account using the setup token from step 4. Setup closes after the first account is created.
8. Use the admin dashboard to add courts and configure the payment link or QR code.

The first request creates the `Settings` and `Bookings` tabs in the Sheet. Large uploaded image data is split into cells below the Sheets per-cell text limit. Keep the Sheet private; only the Apps Script runs as its owner and accesses the Sheet.

## How requests and booking conflicts work

The static client sends requests to Apps Script through a hidden form and iframe, then receives a response with `postMessage`; this avoids browser cross-origin `fetch` restrictions. A booking request stays **Awaiting payment** until the club verifies the payment and marks it **Paid** in the admin dashboard. Only **Paid** bookings block availability. Unpaid and payment-reported requests remain in the admin list but do not reserve the time; if two requests overlap, the script refuses to mark the later conflicting request paid. The script takes an Apps Script lock while checking and writing bookings. Admin endpoints require a session token issued after the admin signs in. The setup token and admin password are not stored in the GitHub files.

Google Apps Script and Sheets have quotas and service limits. This is a low-cost approach for a small venue, not a high-volume transactional booking platform. Quotas can change, and if they are exceeded, requests may fail until service is available again. See [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas).

## Local Node.js alternative

`server.js` remains available for running the original SQLite-backed version locally with Node.js 22.13 or newer:

```sh
node server.js
```

That local server uses `data/booking.sqlite`. GitHub Pages does not run it; for the Google Sheets setup, publish the static site and deploy the Apps Script separately as described above.
