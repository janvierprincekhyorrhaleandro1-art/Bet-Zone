const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const app = express();

// Konfigirasyon CORS pou pèmèt aksè nan API a
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

app.use(express.json());

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uiepdartkcunumajlwwg.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_secret_QkRjPE0nGdy5Y74SOAaoDw_BUrAn7ju';
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// TheSportsDB Key Gratis ("3")
const SPORTSDB_API_KEY = '3';
const BASE_URL = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_API_KEY}`;

// Lis Lig yo pou TheSportsDB
const LEAGUES = [
    { id: '4328', code: 'PL', name: 'English Premier League' },
    { id: '4335', code: 'PD', name: 'Spanish La Liga' },
    { id: '4331', code: 'BL1', name: 'German Bundesliga' },
    { id: '4334', code: 'FL1', name: 'French Ligue 1' },
    { id: '4332', code: 'SA', name: 'Italian Serie A' },
    { id: '4480', code: 'CL', name: 'UEFA Champions League' }
];

// Fonksyon pou fòse sèvè a tann (delay)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. Senkronize match pou jodi a ak jou k ap vini yo depi TheSportsDB
async function syncDailyMatches() {
    console.log(`⏰ [${new Date().toISOString()}] Ekzekisyon senkronizasyon match ak TheSportsDB...`);

    const todayDate = new Date();
    const todayStr = todayDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    for (const league of LEAGUES) {
        try {
            const eventsRes = await fetch(`${BASE_URL}/eventsday.php?d=${todayStr}&l=${encodeURIComponent(league.name)}`);
            const eventsData = await eventsRes.json();

            if (!eventsData.events || eventsData.events.length === 0) {
                console.log(`⚠️ Pa gen match pou ${league.name} jodia (${todayStr}).`);
                continue;
            }

            console.log(`⚽ Jwenn ${eventsData.events.length} match pou ${league.name} sou TheSportsDB.`);

            const { data: existingMatches } = await supabase.from('daily_matches').select('id, victory, percent');
            const existingMap = new Map(existingMatches?.map(m => [m.id, m]) || []);

            const formattedMatches = eventsData.events.map(event => {
                const matchId = parseInt(event.idEvent);
                const existing = existingMap.get(matchId);

                return {
                    id: matchId,
                    league_code: league.code,
                    league_name: league.name,
                    match_date: todayStr,
                    match_time: event.strTime ? event.strTime.substring(0, 5) : '20:00',
                    team_a: event.strHomeTeam,
                    team_b: event.strAwayTeam,
                    victory: existing ? existing.victory : null,
                    percent: existing ? existing.percent : null
                };
            });

            const { error: insErr } = await supabase.from('daily_matches').upsert(formattedMatches, { onConflict: 'id' });

            if (insErr) {
                console.error(`❌ Erè Supabase pou ${league.name}:`, insErr.message);
            } else {
                console.log(`✅ ${formattedMatches.length} match senkronize nan Supabase pou ${league.name}!`);
            }

        } catch (err) {
            console.error(`❌ Erè rale match pou ${league.name}:`, err.message);
        }
    }
}

// 2. Analiz ak Gemini
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

// 3. Generer analiz pou match ki an atant nan fenèt 3 jou
async function generatePendingAnalysis() {
    console.log('🧠 Chèche match ki bezwen analiz (Sèlman pou jodi a ak 2 jou apre)...');

    const todayDate = new Date();
    const maxDate = new Date();
    maxDate.setDate(todayDate.getDate() + 2);

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

app.get('/', (req, res) => {
    res.send('BETZONE Backend (TheSportsDB) active');
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
    console.log(`🚀 Sèvè ap koute sou pò ${PORT} (TheSportsDB mode)`);

    // Senkronize match yo sèlman nan demaraj
    syncDailyMatches();

    // Cron job 2:00 AM pou senkronizasyon chak jou
    cron.schedule('0 2 * * *', async () => {
        console.log('⏰ Ekzekisyon otomatik 2:00 AM kòmanse...');
        await syncDailyMatches();
    }, {
        scheduled: true,
        timezone: "America/New_York"
    });
});