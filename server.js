const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const axios = require('axios');

const app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

app.use(express.json());

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uiepdartkcunumajlwwg.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_secret_QkRjPE0nGdy5Y74SOAaoDw_BUrAn7ju';
const COHERE_KEY = process.env.COHERE_API_KEY;
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY || 'YOUR_FOOTBALL_DATA_KEY_HERE';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const LEAGUES = [
    { code: 'PL', name: 'English Premier League' },
    { code: 'PD', name: 'Spanish La Liga' },
    { code: 'BL1', name: 'German Bundesliga' },
    { code: 'FL1', name: 'French Ligue 1' },
    { code: 'SA', name: 'Italian Serie A' },
    { code: 'CL', name: 'UEFA Champions League' }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Memwa anndan sèvè a pou sere logo ki deja jwenn yo
const logoCache = {};

// Fonksyon pou rale logo yon ekip nan TheSportsDB
async function getTeamLogo(teamName) {
    if (!teamName) return `https://ui-avatars.com/api/?name=Team&background=10b981&color=fff`;

    if (logoCache[teamName]) {
        return logoCache[teamName];
    }

    try {
        const response = await axios.get(
            `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(teamName)}`
        );

        if (response.data && response.data.teams && response.data.teams.length > 0) {
            const logoUrl = response.data.teams[0].strBadge || response.data.teams[0].strLogo;
            if (logoUrl) {
                logoCache[teamName] = logoUrl;
                return logoUrl;
            }
        }

        return `https://ui-avatars.com/api/?name=${encodeURIComponent(teamName)}&background=10b981&color=fff`;
    } catch (error) {
        return `https://ui-avatars.com/api/?name=${encodeURIComponent(teamName)}&background=10b981&color=fff`;
    }
}

// 1. Senkronizasyon Match ak Football-Data.org
async function syncDailyMatches() {
    console.log(`⏰ [${new Date().toISOString()}] Senkronizasyon match...`);
    const now = new Date();
    const todayStr = formatDate(now);
    const futureDate = new Date();
    futureDate.setDate(now.getDate() + 9);
    const maxStr = formatDate(futureDate);

    for (const league of LEAGUES) {
        try {
            const url = `https://api.football-data.org/v4/competitions/${league.code}/matches?dateFrom=${todayStr}&dateTo=${maxStr}`;
            const response = await fetch(url, { headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY } });

            if (!response.ok) continue;

            const data = await response.json();
            const matches = data.matches || [];
            if (matches.length === 0) continue;

            const { data: existingMatches } = await supabase.from('daily_matches').select('id, victory, percent');
            const existingMap = new Map(existingMatches?.map(m => [m.id, m]) || []);

            const formattedMatches = matches.map(match => {
                const matchId = match.id;
                const existing = existingMap.get(matchId);
                const matchUtcDate = new Date(match.utcDate);

                return {
                    id: matchId,
                    league_code: league.code,
                    league_name: league.name,
                    match_date: formatDate(matchUtcDate),
                    match_time: matchUtcDate.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }),
                    team_a: match.homeTeam.name,
                    team_b: match.awayTeam.name,
                    victory: existing ? existing.victory : null,
                    percent: existing ? existing.percent : null
                };
            });

            await supabase.from('daily_matches').upsert(formattedMatches, { onConflict: 'id' });
            await sleep(6000);
        } catch (err) {
            console.error(`❌ Erè senkronizasyon (${league.name}):`, err.message);
        }
    }
}

// 2. Fetch H2H, Form, ak Bilan soti nan Football-Data.org
async function getFootballDataStats(matchId) {
    try {
        const h2hRes = await fetch(`https://api.football-data.org/v4/matches/${matchId}/head2head`, {
            headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY }
        });
        
        let h2hList = [];
        let homeTeamId = null, awayTeamId = null;

        if (h2hRes.ok) {
            const h2hData = await h2hRes.json();
            homeTeamId = h2hData.resultSet?.homeTeam?.id;
            awayTeamId = h2hData.resultSet?.awayTeam?.id;

            h2hList = (h2hData.matches || []).slice(0, 5).map(m => ({
                result: `${m.homeTeam.shortName || m.homeTeam.name} ${m.score.fullTime.home ?? 0} - ${m.score.fullTime.away ?? 0} ${m.awayTeam.shortName || m.awayTeam.name}`,
                date: new Date(m.utcDate).toLocaleDateString('ht-HT')
            }));
        }

        if (!homeTeamId || !awayTeamId) {
            const matchRes = await fetch(`https://api.football-data.org/v4/matches/${matchId}`, {
                headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY }
            });
            if (matchRes.ok) {
                const mData = await matchRes.json();
                homeTeamId = mData.homeTeam?.id;
                awayTeamId = mData.awayTeam?.id;
            }
        }

        let homeForm = ['N','N','N','N','N'], awayForm = ['N','N','N','N','N'];
        let homeBilan = { win: 0, draw: 0, loss: 0 };
        let awayBilan = { win: 0, draw: 0, loss: 0 };

        const parseFormAndBilan = (matches, teamId) => {
            let form = [];
            let win = 0, draw = 0, loss = 0;
            matches.forEach(m => {
                const isHome = m.homeTeam.id === teamId;
                const homeScore = m.score.fullTime.home;
                const awayScore = m.score.fullTime.away;

                if (homeScore === awayScore) {
                    form.push('N'); draw++;
                } else if ((isHome && homeScore > awayScore) || (!isHome && awayScore > homeScore)) {
                    form.push('G'); win++;
                } else {
                    form.push('P'); loss++;
                }
            });
            return { form: form.length ? form : ['N','N','N','N','N'], bilan: { win, draw, loss } };
        };

        if (homeTeamId) {
            const hFormRes = await fetch(`https://api.football-data.org/v4/teams/${homeTeamId}/matches?status=FINISHED&limit=5`, {
                headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY }
            });
            if (hFormRes.ok) {
                const hData = await hFormRes.json();
                const resParsed = parseFormAndBilan(hData.matches || [], homeTeamId);
                homeForm = resParsed.form;
                homeBilan = resParsed.bilan;
            }
        }

        if (awayTeamId) {
            const aFormRes = await fetch(`https://api.football-data.org/v4/teams/${awayTeamId}/matches?status=FINISHED&limit=5`, {
                headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY }
            });
            if (aFormRes.ok) {
                const aData = await aFormRes.json();
                const resParsed = parseFormAndBilan(aData.matches || [], awayTeamId);
                awayForm = resParsed.form;
                awayBilan = resParsed.bilan;
            }
        }

        return { h2h: h2hList, forme: { home: homeForm, away: awayForm }, bilan: { home: homeBilan, away: awayBilan } };

    } catch (e) {
        return { h2h: [], forme: { home: ['N','N','N','N','N'], away: ['N','N','N','N','N'] }, bilan: { home: { win: 0, draw: 0, loss: 0 }, away: { win: 0, draw: 0, loss: 0 } } };
    }
}

// 3. ANALIZ MATCH AK COHERE API
async function analyzeMatch(match) {
    if (!COHERE_KEY) throw new Error('COHERE_API_KEY pa konfigire');

    const prompt = `Ou se yon ekspè nan analiz matche foutbòl. Fè yon rechèch REYÈL sou entènèt pou match sa a: ${match.team_a} vs ${match.team_b} (${match.league_name}).

SWIV MANSYON SA YO EGZAKTEMAN:

1. **"pronostik"**: Chèche pronostik ki pibliye sou entènèt pou match sa a (Home Win %, Draw %, Over/Under). Itilize done reyèl ou jwenn yo.
2. **"analiz_ia"**: Fè yon rechèch sou fòm rezan tou de ekip yo, epi ekri yon ti analiz an Kreyòl ki baze sou sa w jwenn.
3. **"lineup"**: Chèche 11 jwè ki te kòmanse nan 2 DÈNYE match chak ekip, epi DEDUI yon konpozisyon pwobab.
4. **"absences"**: Chèche jwè blese oswa sispann pou toude ekip yo.
5. **"recommendation"**: Yon konsèy final kout baze sou tout rechèch ou fè.

Reponn SÈLMAN ak yon objè JSON valid (san okenn tèks anplis), ki swiv EGZAKTEMAN estrikti sa a:
{
  "pronostik": [{"label": "${match.team_a} Win", "confidence": 65}, {"label": "Over 2.5", "confidence": 70}],
  "analiz_ia": "Analiz IA an ap jenere...",
  "lineup": {
    "home": {"formation":"4-3-3", "gk":["Non GK"], "df":["DF1","DF2","DF3","DF4"], "mid":["MID1","MID2","MID3"], "fw":["FW1","FW2","FW3"]},
    "away": {"formation":"4-3-3", "gk":["Non GK"], "df":["DF1","DF2","DF3","DF4"], "mid":["MID1","MID2","MID3"], "fw":["FW1","FW2","FW3"]}
  },
  "absences": {"home": [{"name":"Non Jwè", "status":"Blese"}], "away": [{"name":"Non Jwè", "status":"Sispann"}]},
  "recommendation": "<ti konsèy kout>"
}`;

    const coRes = await fetch('https://api.cohere.com/v1/chat', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${COHERE_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'command-a-03-2025',
            message: prompt,
            connectors: [{ id: 'web-search' }]
        })
    });

    const data = await coRes.json();

    if (!coRes.ok) {
        throw new Error(`Cohere HTTP ${coRes.status}: ${data.message || JSON.stringify(data)}`);
    }

    let rawText = data.text || '';
    if (!rawText) {
        throw new Error(`Cohere pa retounen tèks: ${JSON.stringify(data)}`);
    }
    rawText = rawText.replace(/```json|```/g, '').trim();

    try {
        return JSON.parse(rawText);
    } catch (e) {
        throw new Error(`JSON envalid soti nan Cohere: ${rawText.substring(0, 200)}`);
    }
}

// 4. Endpoint Detay Match
app.get('/api/match-details/:matchId', async (req, res) => {
    const matchId = req.params.matchId;

    try {
        const { data: cached } = await supabase
            .from('match_analysis')
            .select('data, created_at')
            .eq('match_id', matchId)
            .maybeSingle();

        if (cached && (new Date(cached.created_at).toDateString() === new Date().toDateString())) {
            return res.json({ ...cached.data, cached: true });
        }

        const { data: match } = await supabase
            .from('daily_matches')
            .select('*')
            .eq('id', matchId)
            .single();

        if (!match) {
            return res.status(404).json({ error: 'Match pa jwenn' });
        }

        const footballDataStats = await getFootballDataStats(matchId);

        let geminiParsed = {
            pronostik: [],
            analiz_ia: 'Analiz IA an ap jenere...',
            lineup: null,
            absences: { home: [], away: [] },
            recommendation: 'Konsèy ap disponib nan kèk sekonn.'
        };

        try {
            geminiParsed = await analyzeMatch(match);
        } catch (gemErr) {
            console.error('⚠️ Erè Cohere (Fallback ekzekite):', gemErr.message);
        }

        // Chèche logo 2 ekip yo otomatikman ak TheSportsDB
        const [homeLogo, awayLogo] = await Promise.all([
            getTeamLogo(match.team_a),
            getTeamLogo(match.team_b)
        ]);

        const finalResponse = {
            matchInfo: {
                league: match.league_name,
                status: 'Annatant',
                date: match.match_date,
                homeName: match.team_a,
                awayName: match.team_b,
                homeLogo: homeLogo,
                awayLogo: awayLogo
            },
            pronostik: geminiParsed.pronostik || [],
            analiz_ia: geminiParsed.analiz_ia || '',
            bilan: footballDataStats.bilan,
            forme: footballDataStats.forme,
            h2h: footballDataStats.h2h,
            lineup: geminiParsed.lineup,
            absences: geminiParsed.absences || { home: [], away: [] },
            recommendation: geminiParsed.recommendation || ''
        };

        await supabase.from('match_analysis').upsert({
            match_id: matchId,
            data: finalResponse,
            created_at: new Date().toISOString()
        });

        return res.json({ ...finalResponse, cached: false });

    } catch (err) {
        console.error('❌ Erè match-details:', err);
        return res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Sèvè ap koute sou pò ${PORT}`));