# moveplus-backend
Acitivity types per day logic


## How It Works

- User completes a **Walk** activity → earns Energy
- User tries to start a **Run** activity → app blocks earning and shows a message
- User tries to start a **Cycle** activity → app blocks earning and shows a message
- If the user somehow bypasses the app-level check, the **database trigger awards 0 Energy**
- Activities are still tracked for history and streaks
- Next day (after **10 PM daily reset**) → user can earn from any activity type again

This rule prevents earning Energy from multiple activity types within the same day.
