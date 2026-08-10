import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai";

serve(async (req) => {
  try {
    const FOOTBALL_DATA_TOKEN = Deno.env.get("FOOTBALL_DATA_TOKEN")!;
    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

    // 1. Fetch match jou a
    const response = await fetch("https://api.football-data.org/v4/matches", {
      headers: { "X-Auth-Token": FOOTBALL_DATA_TOKEN },
    });
    const data = await response.json();
    const matches = data.matches || [];

    let processedCount = 0;

    for (const match of matches) {
      const homeTeam = match.homeTeam.name;
      const awayTeam = match.awayTeam.name;
      const league = match.competition.name;
      const matchTime = match.utcDate;

      // Save Match
      const { data: savedMatch, error: matchErr } = await supabase
        .from("matches")
        .insert([{
          league: league,
          home_team: homeTeam,
          away_team: awayTeam,
          match_time: matchTime,
          status: match.status
        }])
        .select()
        .single();

      if (matchErr) continue;

      // 2. Rele Gemini
      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-pro",
        tools: [{ googleSearch: {} }]
      });

      const prompt = `
      Analize match sa a: ${homeTeam} vs ${awayTeam}.
      1. Fè rechèch sou sit 'Betmines' pou pronostik ekip k ap genyen an ak % konfyans.
      2. Fè rechèch sou Google pou H2H, fòm 5 dènye jwèt yo, 11 jwè (line-up), ak analiz an kreyòl ayisyen.
      
      Reponn SÈLMAN nan fòma JSON sa a:
      {
        "option_name": "Victoire ${homeTeam}",
        "confidence": 80,
        "risk_level": "Faible",
        "ai_analysis_text": "Tèks analiz an kreyòl...",
        "lineup_json": { "home": [], "away": [] }
      }
      `;

      try {
        const aiResult = await model.generateContent(prompt);
        const rawText = aiResult.response.text();
        const cleanJson = rawText.replace(/```json|```/g, "").trim();
        const aiData = JSON.parse(cleanJson);

        // Save Prediction
        await supabase.from("predictions").insert([{
          match_id: savedMatch.id,
          option_name: aiData.option_name,
          confidence: aiData.confidence,
          risk_level: aiData.risk_level,
          ai_analysis_text: aiData.ai_analysis_text,
          lineup_json: aiData.lineup_json
        }]);

        processedCount++;
      } catch (err) {
        console.error(`Erè nan Gemini:`, err);
      }
    }

    return new Response(JSON.stringify({ success: true, processed: processedCount }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { "Content-Type": "application/json" },
      status: 500,
    });
  }
});
