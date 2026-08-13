const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uiepdartkcunumajlwwg.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_secret_QkRjPE0nGdy5Y74SOAaoDw_BUrAn7ju';
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || '1d6fdcd8b34649fdaf25ddbbb47ac3ac';
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Fonksyon pou fòse sèvè a tann (delay)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. Rale match pou 10 jou devan pou mete nan kalandriye Supabase la
async function syncDailyMatches() {
    console.log(`⏰ [${new Date().toISOString()}] Ekzekisyon senkronizasyon match...`);

    const todayDate = new Date();
    const futureDate = new Date();
    futureDate.setDate(todayDate.getDate() + 10);

    const today = todayDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const toDateStr = futureDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    console.log(`📅 Chèche match pou kalandriye ant: ${today} ak ${toDateStr}`);

    try {
        const response = await fetch(`https://api.football-data.org/v4/matches?competitions=PL,PD,BL1,SA,FL1,CL&dateFrom=${today}&dateTo=${toDateStr}`, {
            headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY }
        });

        const data = await response.json();

        if (data.message) {
            console.error("❌ Erè ki soti nan Football-Data.org:", data.message);
            return;
        }

        if (data.matches && data.matches.length > 0) {
            console.log(`⚽ Jwenn ${data.matches.length} match sou Football-Data.org.`);

            const { data: existingMatches } = await supabase.from('daily_matches').select('id, victory, percent');
            const existingMap = new Map(existingMatches?.map(m => [m.id, m]) || []);

            const formattedMatches = data.matches.map(item => {
                const code = item.competition.code || 'ALL';
                const realMatchDate = item.utcDate ? item.utcDate.split('T')[0] : today;
                const existing = existingMap.get(item.id);

                return {
                    id: item.id,
                    league_code: code,
                    league_name: item.competition.name,
                    match_date: realMatchDate,
                    match_time: new Date(item.utcDate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }),
                    team_a: item.homeTeam.name,
                    team_b: item.awayTeam.name,
                    victory: existing ? existing.victory : null,
                    percent: existing ? existing.percent : null
                };
            });

            const { error: insErr } = await supabase.from('daily_matches').upsert(formattedMatches, { onConflict: 'id' });
            if (insErr) {
                console.error("❌ Erè enskripsyon nan Supabase:", insErr);
            } else {
                console.log(`✅ ${formattedMatches.length} match (sou 10 jou) senkronize nan Supabase!`);
            }
        } else {
            console.log("⚠️ Pa gen okenn match pou peryòd sa a sou Football-Data.org.");
        }
    } catch (err) {
        console.error("❌ Erè nan fonksyon sync la:", err);
    }
}

async function analyzeMatch(match) {
    if (!GEMINI_KEY) {
        throw new Error('GEMINI_API_KEY pa konfigire sou sèvè a');
    }

    const prompt = `Fè yon rechèch REYÈL sou entènèt pou match foutbòl sa a: ${match.team_a} vs ${match.team_b} (${match.league_name}).

RÈG SOUS POU CHAK SEKSYON (obligatwa, swiv yo egzakteman):
1. "pronostik": Chèche VRÈ pronostik ki pibliye sou site BETMINES pou match sa a (Home Win %, Draw %, Over/Under, BTTS...). Itilize done sa yo pou ranpli "confidence" ak "risk" — pa envante yo, itilize sa BetMines pibliye reyèlman.
2. "analiz_ia": Se PWÒP DEDIKSYON pa ou (AI a) — baze sou rechèch ou fè sou FÒM RESAN tou de ekip yo (dènye match yo, dinamik aktyèl). Ekri yon paragraf ki eksplike konklizyon pa ou.
3. "forme": Chèche 5 dènye rezilta chak ekip SOU SITE BETMINES.
4. "h2h": Chèche 5 dènye match ant de ekip yo SOU SITE BETMINES.
5. "absences": Chèche jwè blese oswa sispann ki pp jwe match sa pou toude ekip yo SOU GOOGLE.
6. "lineup": PA kopye yon konpozisyon deja pibliye — DEDUI li pa ou menm: chèche SOU GOOGLE ki 11 jwè ki te kòmanse (starting XI) nan 2 DÈNYE match chak ekip te jwe, epi konstwi yon konpozisyon pwobab apati sa.
"bilan": baze sou estatistik sezon aktyèl yo, chèche sou site BetMines tou.

Reponn SÈLMAN ak yon objè JSON valid (san okenn tèks anplis, san eksplikasyon), ki swiv EGZAKTEMAN estrikti sa a — chak valè ki anba a se yon <deskripsyon>, ranplase l ak vrè done w jwenn:
{
  "pronostik": [{"label": "<pick BetMines>", "confidence": 80, "risk": "Fèb"}, {"label": "<2yèm pick>", "confidence": 70, "risk": "Modere"}, {"label": "<3yèm pick>", "confidence": 60, "risk": "Elve"}],
  "analiz_ia": "<paragraf dediksyon pa ou, baze sou fòm resan>",
  "bilan": {"home": {"win":0,"draw":0,"loss":0}, "away": {"win":0,"draw":0,"loss":0}},
  "forme": {"home": ["W","W","D","L","W"], "away": ["W","D","L","W","W"]},
  "h2h": [{"result": "<vrè rezilta>", "date": "<vrè dat>"}],
  "absences": {"home": [{"name":"<non jwè>", "status":"<blese/sispann>"}], "away": [{"name":"<non>", "status":"<...>"}]},
  "lineup": {
    "home": {"formation":"4-3-3", "gk":["<non>"], "df":["<4 non>"], "mid":["<3 non>"], "fw":["<3 non>"]},
    "away": {"formation":"4-3-3", "gk":["<non>"], "df":["<4 non>"], "mid":["<3 non>"], "fw":["<3 non>"]}
  },
  "recommendation": "<konklizyon kout pa ou>"
}
Si w vrèman pa jwenn done presi pou yon chan apre rechèch ou yo, mete (Done sa inaksesib).`;

    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${GEMINI_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: "json_object" },
            max_tokens: 4000
        })
    });

    const data = await res.json();

    if (!res.ok) {
        throw new Error(`Gemini HTTP ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
    }

    let rawText = data.choices?.[0]?.message?.content || '';
    if (!rawText) {
        throw new Error(`Gemini pa retounen tèks: ${JSON.stringify(data)}`);
    }

    rawText = rawText.replace(/```json|```/g, '').trim();

    try {
        return JSON.parse(rawText);
    } catch (e) {
        throw new Error(`JSON envalid soti nan modèl la: ${rawText.substring(0, 150)}...`);
    }
}

// 2. SÈLMAN analize match jodi a, demen, ak apre demen!
async function generatePendingAnalysis() {
    console.log('🧠 Chèche match ki bezwen analiz (Sèlman pou jodi a ak 2 jou apre)...');

    const todayDate = new Date();
    const maxDate = new Date();
    maxDate.setDate(todayDate.getDate() + 2); // Jodi a + 2 jou apre (antou 3 jou)

    const todayStr = todayDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const maxDateStr = maxDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    const { data: pending, error } = await supabase
        .from('daily_matches')
        .select('*')
        .is('percent', null)
        .gte('match_date', todayStr)
        .lte('match_date', maxDateStr)
        .limit(10);

    if (error) { console.error('❌ Erè chèche match pou analize:', error); return; }
    if (!pending || pending.length === 0) { console.log('✅ Pa gen okenn match ki bezwen analiz nan fenèt 3 jou sa yo.'); return; }

    console.log(`🧠 ${pending.length} match pou analize nan fenèt 3 jou sa yo...`);

    for (const match of pending) {
        try {
            const parsed = await analyzeMatch(match);
            const topPick = parsed.pronostik?.[0];

            await supabase.from('match_analysis').upsert({
                match_id: match.id,
                data: parsed,
                created_at: new Date().toISOString()
            });

            await supabase.from('daily_matches').update({
                percent: topPick ? `${topPick.confidence}%` : 'N/A',
                victory: topPick ? topPick.label : 'Analiz endisponib'
            }).eq('id', match.id);

            console.log(`✅ Analize: ${match.team_a} vs ${match.team_b} (${match.match_date})`);

            // Poz 4 segonn pou respekte limit API a
            await sleep(4000);

        } catch (err) {
            console.error(`❌ Erè analiz pou ${match.team_a} vs ${match.team_b}:`, err.message);
        }
    }
}

app.use(express.json());

app.get('/', (req, res) => {
    res.send('BETZONE Backend active');
});

app.get('/api/match-details/:matchId', async (req, res) => {
    const matchId = req.params.matchId;

    try {
        const { data: cached } = await supabase
            .from('match_analysis')
            .select('data, created_at')
            .eq('match_id', matchId)
            .maybeSingle();

        const isSameDay = cached && (new Date(cached.created_at).toDateString() === new Date().toDateString());
        if (isSameDay) {
            return res.json({ ...cached.data, cached: true });
        }

        const { data: match, error: matchErr } = await supabase
            .from('daily_matches')
            .select('*')
            .eq('id', matchId)
            .single();

        if (matchErr || !match) {
            return res.status(404).json({ error: 'Match pa jwenn' });
        }

        const parsed = await analyzeMatch(match);

        await supabase.from('match_analysis').upsert({
            match_id: matchId,
            data: parsed,
            created_at: new Date().toISOString()
        });

        return res.json({ ...parsed, cached: false });

    } catch (err) {
        console.error('❌ Erè match-details:', err);
        return res.status(500).json({ error: 'Nou pa t ka jenere analiz la kounye a.' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Sèvè ap koute sou pò ${PORT}`);
    syncDailyMatches().then(() => generatePendingAnalysis());

    // Kouri otomatik chak jou presizeman a 2:00 AM (lè Nouyòk / Ayiti)
    cron.schedule('0 2 * * *', async () => {
        console.log('⏰ Ekzekisyon otomatik 2:00 AM kòmanse...');
        await syncDailyMatches();
        await generatePendingAnalysis();
    }, {
        scheduled: true,
        timezone: "America/New_York"
    });
});