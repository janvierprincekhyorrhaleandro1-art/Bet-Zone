const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = 'https://uiepdartkcunumajlwwg.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_secret_QkRjPE0nGdy5Y74SOAaoDw_BUrAn7ju';
const API_SPORTS_KEY = process.env.API_SPORTS_KEY || '642b2222ba559586a9a165bcd30053b4';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function syncDailyMatches() {
    const lèLokal = new Date().toLocaleTimeString('fr-FR', { timeZone: 'America/New_York' });
    console.log(`[${lèLokal}] Senkronizasyon tout match jounen an kòmanse...`);
    
    const today = new Date().toISOString().split('T')[0];

    try {
        const response = await fetch(`https://v3.football.api-sports.io/fixtures?date=${today}`, {
            headers: { 'x-apisports-key': API_SPORTS_KEY }
        });

        const data = await response.json();

        if (data.response && data.response.length > 0) {
            console.log(`Mwen jwenn ${data.response.length} match pou jodi a sou API-Sports!`);

            const formattedMatches = data.response.map(item => {
                let lCode = 'ALL';
                const id = item.league.id;

                // MAPPING TOUT CHANPYONA POPOPILÈ YO
                if (id === 39) lCode = 'PL';         // Premier League
                else if (id === 140) lCode = 'PD';   // LaLiga
                else if (id === 78) lCode = 'BL1';   // Bundesliga
                else if (id === 61) lCode = 'FL1';   // Ligue 1
                else if (id === 135) lCode = 'SA';   // Serie A
                else if (id === 2) lCode = 'CL';     // Champions League
                else if (id === 3) lCode = 'EL';     // Europa League
                else if (id === 88) lCode = 'DED';   // Eredivisie
                else if (id === 94) lCode = 'PPL';   // Liga Portugal
                else if (id === 13) lCode = 'CLI';   // Copa Libertadores
                else if (id === 253) lCode = 'MLS';  // Major League Soccer

                return {
                    id: item.fixture.id,
                    league_code: lCode, // Si l pa nan liy sa yo, l ap toujou ret 'ALL'
                    league_name: item.league.name,
                    match_time: new Date(item.fixture.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    team_a: item.teams.home.name,
                    team_b: item.teams.away.name,
                    victory: `Viktwa ${item.teams.home.name}`,
                    percent: `${Math.floor(Math.random() * 15) + 78}%`,
                    analysis: 'Analiz spòtif kalkile pa rezo'
                };
            });

            // Vide ansyen match yo epi antre TOUT nouvo yo
            await supabase.from('daily_matches').delete().neq('id', 0);
            const { error } = await supabase.from('daily_matches').insert(formattedMatches);

            if (error) throw error;
            console.log(`✅ ${formattedMatches.length} match antre anndan Supabase byen pwòp!`);
        } else {
            await supabase.from('daily_matches').delete().neq('id', 0);
            console.log("⚠️ Pa gen okenn match reyèl ki jwenn pou jodi a sou API-Sports.");
        }
    } catch (err) {
        console.error("❌ Erè nan senkronizasyon an:", err);
    }
}

app.get('/', (req, res) => {
    res.send('BETZONE Backend active ak Cron Job!');
});

app.listen(PORT, () => {
    console.log(`Sèvè ap koute sou pò ${PORT}`);
    
    // Ekzekite touswit pou n chaje tout match yo san tann!
    syncDailyMatches();
    
    // Cron job (3:30 AM chak jou)
    cron.schedule('30 3 * * *', async () => {
        await syncDailyMatches();
    }, {
        scheduled: true,
        timezone: "America/New_York"
    });
});
