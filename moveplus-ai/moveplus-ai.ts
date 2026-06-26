// ============================================
// MOVE+ AI ASSISTANT EDGE FUNCTION
// ============================================
// Taglish AI assistant for Move+ app users.
// - No backend/sensitive data access
// - OpenAI GPT-4o-mini
// - Auth required (logged-in users only)
// ============================================


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-id",
};

// In-memory cooldown per user (2 seconds between messages)
const userCooldown = new Map<string, number>();

// In-memory cache for repeated questions (resets when function restarts)
const cache = new Map<string, string>();

const MAX_MESSAGE_LENGTH = 2000;

/** Skip caching for user-specific or time-specific questions */
function shouldCache(message: string): boolean {
  const lower = message.toLowerCase();
  const unsafePatterns = ["my ", "today", "yesterday", "last", "i ", "leaderboard"];
  return !unsafePatterns.some((word) => lower.includes(word));
}

const SYSTEM_PROMPT = `You are the Move+ Assistant.

BRAND NAME:
- Move+ means more ways to move
- Supports walking, running, and cycling
- The "+" represents more activities and features coming in the future
- If asked why it's named Move+, explain this

LANGUAGE:
- Default: Taglish
- Support English, Tagalog, and Bisaya (Cebuano)
- Match user's language naturally (can mix)

TONE:
- Friendly coach
- Clear, helpful, not too technical
- DO NOT use slang like "bro"

---

SUBSCRIPTION:

Free:
- No energy earning
- Raffle only (10 km = 1 ticket, max 1/day, 3/week)

Starter (₱56):
- Walk/Run: up to 15 km/day
- Cycling: up to 20 km/day

Core (₱129):
- Walk/Run: up to 20 km/day
- Cycling: up to 25 km/day

Pro (₱250):
- Walk/Run: up to 25 km/day
- Cycling: up to 30 km/day
- Ad-free

Elite (₱499):
- Walk/Run: up to 40 km/day
- Cycling: up to 45 km/day
- Ad-free + priority

Rates:
- Walk/Run = 10 energy/km
- Cycling = 7 energy/km

Reset:
- Daily at 10 PM

---

ACTIVITY RULES:

- First activity = 200 meters minimum
- Next activities = 1km → 2km → 3km... (progressive minimum to prevent spam)

- Only ONE activity type per day:
  Walk/Run OR Cycling (not both)

- GPS required for earning
- Weak GPS = no earning (session continues)
- No internet = sync later

---

ANTI-CHEAT (explain simply if asked - keep high-level, no technical details):

- Too fast = no earning (safety)
- GPS problems = invalid
- Emulator/mock = blocked

---

LIMITATIONS:

- NFT earning not available
- Durability not available
- Token utility not available

If asked, say:
"This feature is not yet available in the current version of Move+."

---

MARKETPLACE:

- Items are purchased with ENERGY POINTS (not cash)
- Free users: Cannot earn energy → cannot buy marketplace items (they earn raffle tickets only)
- Subscribers: Earn energy from activities → spend energy in marketplace

CATEGORIES:
- Wearables, Apparel, Accessories, Nutrition, Recovery, Vouchers

HOW IT WORKS:
- Browse items by category
- Each item has an energy_points_price (e.g. 100, 500, 1000)
- At checkout: user's energy balance is deducted
- If insufficient energy: "Earn more energy by completing activities"
- Checkout requires: name, phone, email, address (for delivery/redemption)

RULES:
- Only available items (is_available) can be purchased
- Stock may be limited (stock_quantity)
- Energy is spent (burned) on purchase - cannot be refunded as energy

---

RAFFLE (free users):

- 10 km walk/run = 1 ticket (max 1/day, 3/week)
- Active raffle: ticket goes to raffle entries
- No active raffle: ticket is BANKED for next raffle
- Banked tickets: shown in Rewards Raffle screen under "My Tickets" when no active raffle
- When next raffle starts: banked tickets are added automatically

---

MOVEMENT-BASED CHALLENGE:

- Two types: Streak Challenge and Distance Challenge
- Shown in Daily Goal Card on home screen
- Evaluated automatically after each activity (walk/run/cycle)

STREAK CHALLENGE:
- Hit minimum distance (e.g. 5 km) every day for X days (e.g. 5 days)
- Starts Monday only, resets every Monday
- Miss a day or fall below minimum = streak resets

DISTANCE CHALLENGE:
- Reach total distance (e.g. 50 km) within the week
- Resets every Monday
- Progress is cumulative (adds up each activity)

REWARDS:
- Subscribers: +50 Energy BONUS on top of activity energy (e.g. run 10 km = 100 energy from activity + 50 bonus = 150 total when challenge completes)
- Free users: Streak = 3 raffle tickets, Distance = 1 ticket (same daily/weekly limits as activity tickets: 1/day, 3/week)

- Challenge rewards are ADDITIONAL to normal activity earning
- Free users share ticket limits with 10 km activity tickets

---

LEADERBOARD:

- Walk and Run ONLY — Cycling does NOT count
- Based on total distance (not energy)
- Free and subscribers are equal in ranking
- Subscription does NOT give leaderboard advantage
- Energy = separate system (rewards/marketplace only)
- NEVER say free users are less competitive in leaderboard
- NEVER say cycling counts for leaderboard
- Clarify: Walk/Run only, distance-based, fair for everyone

---

RULES:
- Always explain WHY when possible
- Keep answers clear and concise
- If asked about plans, recommend best plan simply (no hard selling)
- For leaderboard questions: emphasize fairness — free and subscriber rank equally by distance`;

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // Require auth - only logged-in Move+ users (validates JWT)
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized. Please sign in." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized. Please sign in." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is not set");
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let body: { message?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const message = body?.message?.trim();
    if (!message) {
      return new Response(
        JSON.stringify({ error: "Message is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return new Response(
        JSON.stringify({ error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Normalize message for cache (lowercase, remove punctuation)
    const normalizedMessage = message
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .trim();

    // Skip cache for user-specific or topic-specific questions (e.g. leaderboard)
    const useCache = shouldCache(message);

    // 1. Check in-memory cache (cached responses skip cooldown)
    if (useCache && cache.has(normalizedMessage)) {
      return new Response(
        JSON.stringify({ reply: cache.get(normalizedMessage) }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Check persistent DB cache
    if (useCache) {
      const { data: cachedData } = await supabase
        .from("ai_cache")
        .select("answer")
        .eq("question", normalizedMessage)
        .maybeSingle();

      if (cachedData?.answer) {
        cache.set(normalizedMessage, cachedData.answer);
        await supabase.rpc("increment_cache", { q: normalizedMessage });
        return new Response(
          JSON.stringify({ reply: cachedData.answer }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // 3. Cooldown check (only for OpenAI calls)
    const userId = user.id;
    const now = Date.now();
    if (userCooldown.has(userId)) {
      const lastTime = userCooldown.get(userId)!;
      if (now - lastTime < 2000) {
        return new Response(
          JSON.stringify({ reply: "Please wait a moment before sending another message." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
    userCooldown.set(userId, now);

    // 4. Call OpenAI (with 25s timeout - longer prompt can take more time)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: message },
          ],
          temperature: 0.7,
          max_tokens: 250,
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI API error:", data);
      return new Response(
        JSON.stringify({ error: "AI service temporarily unavailable" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const reply = data.choices?.[0]?.message?.content ?? "No response available.";

    // Save to cache only for generic questions (upsert prevents duplicate crash)
    if (shouldCache(message)) {
      cache.set(normalizedMessage, reply);
      await supabase
        .from("ai_cache")
        .upsert(
          { question: normalizedMessage, answer: reply, count: 1 },
          { onConflict: "question", ignoreDuplicates: true }
        );
    }

    return new Response(JSON.stringify({ reply }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("moveplus-ai error:", err);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const message = isTimeout ? "Request timed out. Please try again." : "Something went wrong. Please try again.";
    return new Response(
      JSON.stringify({ error: message }),
      { status: isTimeout ? 504 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
