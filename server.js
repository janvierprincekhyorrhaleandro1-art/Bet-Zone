import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

app.get('/cron/sync-matches', async (req, res) => {
    try {
        const response = await fetch("https://api.football-data.org/v4/matches", {
            headers: { "X-Auth-Token": FOOTBALL_DATA_TOKEN }
        });
        
        const data = await response.json();
        
        if (data.message) {
            return res.status(400).json({ error: data.message });
        }

        const matches = data.matches || [];
        let count = 0;
        let errors = [];

        for (const match of matches) {
            const homeTeam = match.homeTeam.name;
            const awayTeam = match.awayTeam.name;
            const league = match.competition.name;
            const matchTime = match.utcDate;

            let activeMatch = null;

            // 1. Tcheke si match la deja nan baz de done a
            const { data: existingMatch } = await supabase
                .from("matches")
                .select("*")
                .eq("home_team", homeTeam)
                .eq("away_team", awayTeam)
                .eq("match_time", matchTime)
                .single();

            if (existingMatch) {
                activeMatch = existingMatch;
            } else {
                // 2. Insérer match la si l pa la
                const { data: insertedMatch, error: insertErr } = await supabase
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

                if (insertErr) {
                    errors.push(`Insert Err (${homeTeam}): ${insertErr.message}`);
                    continue;
                }
                activeMatch = insertedMatch;
            }

            // 3. Tcheke si gen prediksyon deja
            const { data: existingPred } = await supabase
                .from("predictions")
                .select("id")
                .eq("match_id", activeMatch.id)
                .single();

            if (existingPred) {
                count++;
                continue;
            }

            // 4. Rechèch an tan reyèl ak Tavily API
            let liveContext = "";
            try {
                const tavilyRes = await fetch("https://api.tavily.com/search", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        api_key: TAVILY_API_KEY,
                        query: `site:betmines.com ${homeTeam} vs ${awayTeam} prediction injuries news stats`,
                        search_depth: "basic",
                        max_results: 3
                    })
                });

                const tavilyData = await tavilyRes.json();
                if (tavilyData.results && tavilyData.results.length > 0) {
                    liveContext = tavilyData.results.map(r => r.content).join(" ");
                }
            } catch (tErr) {
                console.log("Erè rechèch Tavily:", tErr.message);
            }

            // 5. Prompt avanse ki baze sou done an tan reyèl yo
            const prompt = `
            Ou se yon ekspè nan analiz spòtif. Analize match sa a: ${homeTeam} vs ${awayTeam} (${league}).
            
            Men enfòmasyon aktyèl an tan reyèl ki sot nan rechèch Tavily/BetMines:
            "${liveContext}"

            Sèvi ak enfòmasyon sa yo pou w bay detay sa yo presizman an Kreyòl Ayisyen:
            - Pousantaj ganye: Ekip Lakay %, Nul %, Ekip Deyò % (som lan dwe fè 100).
            - Bilan Lakay vs Deyò pou 2 ekip yo.
            - Fòm 5 dènye match yo.
            - 4 dènye konfwontasyon H2H.
            - Jwè ki absan (Blese / Sanksyon) pou chak ekip an tan reyèl.
            - Kout analiz ak Rekòmandasyon Aktyalite.

            Reponn SÈLMAN nan fòma JSON sa a presizman (san okenn lòt tèks deyò JSON la):
            {
              "option_name": "Victoire ${homeTeam}",
              "confidence": 75,
              "risk_level": "Moyen",
              "home_win_pct": 55,
              "draw_pct": 25,
              "away_win_pct": 20,
              "home_away_stat": "Estatistik lakay ak deyò...",
              "form_last_5": {
                "home": ["V", "V", "N", "D", "V"],
                "away": ["D", "N", "V", "D", "D"]
              },
              "h2h_history": [
                "Rezilta 1",
                "Rezilta 2",
                "Rezilta 3",
                "Rezilta 4"
              ],
              "missing_players": {
                "home": ["Jwè blese 1"],
                "away": ["Jwè blese 2"]
              },
              "ai_analysis_text": "Analiz detaye an kreyòl...",
              "news_recommendation": "Ti konsèy aktyalite...",
              "lineup_json": { "home": [], "away": [] }
            }
            `;

            try {
                const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: "meta-llama/llama-3.1-8b-instruct:free",
                        messages: [{ role: "user", content: prompt }],
                        response_format: { type: "json_object" }
                    })
                });

                const aiDataJson = await aiRes.json();

                if (aiDataJson.error) {
                    errors.push(`OpenRouter API Err (${homeTeam}): ${aiDataJson.error.message}`);
                    continue;
                }

                const aiData = JSON.parse(aiDataJson.choices[0].message.content);

                // 6. Anrejistre done ki ajou yo nan Supabase
                await supabase.from("predictions").insert([{
                    match_id: activeMatch.id,
                    option_name: aiData.option_name,
                    confidence: aiData.confidence,
                    risk_level: aiData.risk_level,
                    home_win_pct: aiData.home_win_pct,
                    draw_pct: aiData.draw_pct,
                    away_win_pct: aiData.away_win_pct,
                    home_away_stat: aiData.home_away_stat,
                    form_last_5: aiData.form_last_5,
                    h2h_history: aiData.h2h_history,
                    missing_players: aiData.missing_players,
                    ai_analysis_text: aiData.ai_analysis_text,
                    news_recommendation: aiData.news_recommendation,
                    lineup_json: aiData.lineup_json
                }]);

                count++;

            } catch (err) {
                errors.push(`OpenRouter Catch Err (${homeTeam}): ${err.message}`);
            }
        }

        res.json({ 
            success: true, 
            matches_processed: count, 
            total_matches_found: matches.length,
            debug_errors: errors 
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`Server ap kouri sou pòt ${PORT}`));
