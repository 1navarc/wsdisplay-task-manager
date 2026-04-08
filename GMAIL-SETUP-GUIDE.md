# Connecting Gmail to WSDisplay Email

Your app is live at: **https://wsdisplay-email-345944651769.us-central1.run.app/**

Right now it runs with demo data. Follow these steps to connect your real Gmail accounts.

---

## Step 1: Create OAuth Credentials in Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials?project=wsdisplay-email)
2. Click **+ CREATE CREDENTIALS** at the top, then select **OAuth client ID**
3. For "Application type," choose **Web application**
4. Give it a name like "WSDisplay Email"
5. Under **Authorized redirect URIs**, click **+ ADD URI** and enter:
   ```
   https://wsdisplay-email-345944651769.us-central1.run.app/auth/callback
   ```
6. Click **CREATE**
7. You'll see a dialog with your **Client ID** and **Client Secret** — copy both of these somewhere safe

## Step 2: Configure the OAuth Consent Screen

If you haven't already set up the consent screen:

1. Go to [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent?project=wsdisplay-email)
2. Choose **External** (or Internal if this is a Workspace account and you only want org users)
3. Fill in the required fields:
   - App name: **WSDisplay Email**
   - User support email: your email
   - Developer contact email: your email
4. On the **Scopes** page, click **ADD OR REMOVE SCOPES** and add:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/gmail.labels`
   - `https://mail.google.com/`
5. On the **Test users** page, add the Gmail addresses you want to connect (required while the app is in "Testing" mode)
6. Click **SAVE AND CONTINUE** through the rest

## Step 3: Enable the Gmail API

1. Go to [Gmail API page](https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=wsdisplay-email)
2. Click **ENABLE** if it's not already enabled

## Step 4: Set Environment Variables on Cloud Run

Open Cloud Shell and run this command (replace the placeholder values with your actual credentials from Step 1):

```bash
gcloud run services update wsdisplay-email \
  --region us-central1 \
  --set-env-vars "GOOGLE_CLIENT_ID=YOUR_CLIENT_ID_HERE,GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET_HERE,GOOGLE_REDIRECT_URI=https://wsdisplay-email-345944651769.us-central1.run.app/auth/callback,SESSION_SECRET=$(openssl rand -hex 32)"
```

This restarts the service with your Gmail credentials configured.

## Step 5: Connect a Gmail Account

Once the environment variables are set, you can connect accounts through the app's API:

1. Open your browser and go to:
   ```
   https://wsdisplay-email-345944651769.us-central1.run.app/auth/url?email=YOUR_GMAIL@gmail.com
   ```
   (Replace `YOUR_GMAIL@gmail.com` with the actual Gmail address you want to connect)

2. You'll get a JSON response with an `authUrl` — click or copy that URL into your browser
3. Sign in with the Gmail account and grant permissions
4. You'll see a "Account Connected!" confirmation page
5. Repeat for any additional Gmail accounts you want to connect

## Step 6: Verify It Works

Check connected accounts by visiting:
```
https://wsdisplay-email-345944651769.us-central1.run.app/auth/accounts
```

Check the health endpoint:
```
https://wsdisplay-email-345944651769.us-central1.run.app/health
```

---

## Important Notes

- **Testing mode**: While your OAuth app is in "Testing" status, only the test users you added in Step 2 can authorize. To allow anyone, you'd need to submit for Google verification.
- **Token storage**: Currently tokens are stored in memory, so they reset when the Cloud Run instance restarts. For persistent storage, you'd want to add Firestore or Cloud SQL.
- **Security**: The `SESSION_SECRET` environment variable should be a random string (the command above generates one automatically).
