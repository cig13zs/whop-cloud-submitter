# Privacy policy

Last updated: 2026-11-14

This repository runs a private tool ("Creator upload scheduler") that one person uses on YouTube channels they own. It has no other users.

## What it accesses
- Through YouTube API Services, with the channel owner's OAuth consent: uploading the owner's own videos, reading the status and metadata of the owner's own videos and channels, and reading the owner's own YouTube Analytics reports.
- It does not access anyone else's channels, videos, comments or personal data.

## How data is stored
- OAuth refresh tokens are stored as encrypted GitHub Actions secrets and in local files only the owner can read.
- Video files and the upload schedule are stored encrypted (AES-256-GCM). Only ciphertext is committed to this public repository.
- YouTube data is used only to schedule and check the owner's uploads and to plan future videos. It is not sold, shared or used for advertising.

## Deleting data
The owner can revoke the tool's access at any time at https://myaccount.google.com/permissions. Stored tokens and staged files are deleted when they are no longer needed.

## Google and YouTube terms
This tool uses YouTube API Services. See the YouTube Terms of Service (https://www.youtube.com/t/terms) and the Google Privacy Policy (https://policies.google.com/privacy).

## Contact
Open an issue on this repository.
