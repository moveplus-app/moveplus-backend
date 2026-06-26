# Move+ AI Assistant

Edge Function for the Move+ in-app AI assistant (Taglish).

## Setup

```bash
# 1. Set OpenAI API key
supabase secrets set OPENAI_API_KEY=sk-your-openai-key

# 2. Deploy
supabase functions deploy moveplus-ai
```

## Test (requires valid user JWT)

```bash
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_USER_JWT" \
  -d '{"message":"Bakit wala akong energy?"}'
```

**Note:** Get a valid JWT by signing in via the app (check session) or Supabase Auth.

## Flutter usage (later)

```dart
final response = await Supabase.instance.client.functions.invoke(
  'moveplus-ai',
  body: {'message': userMessage},
);
final reply = response.data['reply'];
```

## Security

- Auth required (logged-in users only)
- Max message length: 2000 chars
- No backend/sensitive data in AI knowledge
- OpenAI key never exposed to client
