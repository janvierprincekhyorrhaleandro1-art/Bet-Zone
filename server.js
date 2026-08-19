const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const axios = require('axios');
const { search } = require('duckduckgo-search');

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
const BAZAARLINK_KEY = process.env.BAZAARLINK_API_KEY;
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

// Generasyon URL Crest/Logo dirèkteman ak Football-Data ID
function getCrestUrl(teamId, teamName) {
    if (teamId) {
        return `https://crests.football-data.org/${teamId}.svg`;
    }
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(teamName || 'Team')}&background=10b981&color=fff`;
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
                    team_a_id: match.homeTeam.id,
                    team_b_id: match.awayTeam.id,
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

        return { 
            homeTeamId,
            awayTeamId,
            h2h: h2hList, 
            forme: { home: homeForm, away: awayForm }, 
            bilan: { home: homeBilan, away: awayBilan } 
        };

    } catch (e) {
        return { homeTeamId: null, awayTeamId: null, h2h: [], forme: { home: ['N','N','N','N','N'], away: ['N','N','N','N','N'] }, bilan: { home: { win: 0, draw: 0, loss: 0 }, away: { win: 0, draw: 0, loss: 0 } } };
    }
}

// Helper pou fè rechèch an tan reyèl ak DuckDuckGo Search (Gratis san API Key)
async function searchWebFree(query) {
    try {
        const searchResults = await search(query);
        const results = searchResults.results || searchResults || [];
        
        if (!Array.isArray(results)) return '';

        return results.slice(0, 3).map(r => `Tit: ${r.title || ''}\nSnippet: ${r.snippet || r.description || ''}`).join('\n---\n');
    } catch (err) {
        console.error('❌ Erè DuckDuckGo Search:', err.message);
        return '';
    }
}

// 3. ANALIZ MATCH AK DUCKDUCKGO + BAZAARLINK API
async function analyzeMatch(match) {
    if (!BAZAARLINK_KEY) throw new Error('BAZAARLINK_API_KEY pa konfigire');

    // 1. DuckDuckGo fè rechèch sou Forebet ak Google/Web pou absans yo
    const forebetQuery = `site:forebet.com ${match.team_a} vs ${match.team_b} prediction`;
    const absenceQuery = `${match.team_a} vs ${match.team_b} injury news missing suspended players`;

    const [forebetResults, absenceResults] = await Promise.all([
        searchWebFree(forebetQuery),
        searchWebFree(absenceQuery)
    ]);

    console.log('🔍 Done Forebet (DuckDuckGo):\n', forebetResults);
    console.log('🔍 Done Absans (DuckDuckGo):\n', absenceResults);

    // 2. Prompt ak enstriksyon trè strik sou ki done pou BazaarLink filtre ak fòmate
    const prompt = `
Mwen ba ou done reyèl ki soti dirèkteman sou Forebet ak Entènèt la pou match sa a: ${match.team_a} vs ${match.team_b} (${match.league_name}).

DONE FOREBET:
${forebetResults || 'Pa gen done Forebet.'}

DONE BLESUR/SANKSYON (ENTÈNÈT):
${absenceResults || 'Pa gen enfòmasyon sou absans.'}

RÈG POU PRONOSTIK AK ABSANS YO (OBLIGATWA):
1. Nan done Forebet yo, gade pousantaj viktwa pou tou de ekip yo. Pran SÈLMAN EKIP KI GEN PI WO POUSANTAJ VIKTWA A (ekip A oswa ekip B) epi mete l kòm premye opsyon nan "pronostik".
2. Pran pousantaj Over 2.5 lan nan Forebet tou, mete l kòm 2yèm opsyon nan "pronostik".
3. Nan done entènèt yo, idantifye byen presi jwè ki blese oswa ki sispann (sanksyone) pou tou de ekip yo.

Reponn SÈLMAN ak yon objè JSON valid ki swiv estrikti sa a (san okenn tèks anplis):
{
  "pronostik": [
    {
      "label": "<Non ekip ki gen PI WO % win an> Win", 
      "confidence": <pousantaj win ki pi wo a san siy %>, 
      "risk": "<Fèb|Modere|Elve>"
    },
    {
      "label": "Over 2.5 Goals", 
      "confidence": <pousantaj over 2.5 an san siy %>, 
      "risk": "<Fèb|Modere|Elve>"
    }
  ],
  "analiz_ia": "<paragraf kout ki esplike poukisa ekip ki gen pi wo % sa an avantaj ak efè jwè ki blese/sispann yo>",
  "absences": {
    "home": [{"name": "<non jwè>", "status": "<blese/sispann>"}],
    "away": [{"name": "<non jwè>", "status": "<blese/sispann>"}]
  },
  "recommendation": "<konklizyon pi bon opsyon an>"
}`;

    // 3. BazaarLink entèprete ak fòmate repons lan
    const response = await axios.post('https://bazaarlink.ai/api/v1/chat/completions', {
        model: 'auto:free',
        messages: [{ role: 'user', content: prompt }]
    }, {
        headers: {
            'Authorization': `Bearer ${BAZAARLINK_KEY}`,
            'Content-Type': 'application/json'
        }
    });

    const data = response.data;
    let rawText = data.choices?.[0]?.message?.content || data.text || '';

    console.log('🔍 Repons BazaarLink:', rawText);

    if (!rawText) {
        throw new Error(`Bazaarlink pa retounen tèks: ${JSON.stringify(data)}`);
    }

    rawText = rawText.replace(/```json|```/g, '').trim();

    try {
        return JSON.parse(rawText);
    } catch (e) {
        throw new Error(`JSON envalid soti nan Bazaarlink: ${rawText.substring(0, 200)}`);
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
            absences: { home: [], away: [] },
            recommendation: 'Konsèy ap disponib nan kèk sekonn.'
        };

        try {
            geminiParsed = await analyzeMatch(match);
        } catch (gemErr) {
            console.error('⚠️ Erè Bazaarlink (Fallback ekzekite):', gemErr.message);
        }

        // Generasyon Logo dirèkteman ak ID ekip Football-Data yo
        const homeLogo = getCrestUrl(match.team_a_id || footballDataStats.homeTeamId, match.team_a);
        const awayLogo = getCrestUrl(match.team_b_id || footballDataStats.awayTeamId, match.team_b);

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

// Otomatisasyon Cron: Ekzekite senkronizasyon match yo otomatikman chak jou a 2:00 AM
cron.schedule('0 2 * * *', async () => {
    console.log('⏰ Otomatisasyon cron kòmanse (2:00 AM)...');
    await syncDailyMatches();
});

// Ekzekite yon premye senkronizasyon depi sèvè a demare
syncDailyMatches();

app.listen(PORT, () => console.log(`🚀 Sèvè ap koute sou pò ${PORT}`));