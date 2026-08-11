const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uiepdartkcunumajlwwg.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_secret_QkRjPE0nGdy5Y74SOAaoDw_BUrAn7ju';
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || '1d6fdcd8b34649fdaf25ddbbb47ac3ac';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function syncDailyMatches() {
    console.log(`⏰ [${new Date().toISOString()}] Ekzekisyon senkronizasyon match...`);

    const todayDate = new Date();
    const futureDate = new Date();
    futureDate.setDate(todayDate.getDate() + 10);

    const today = todayDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const toDateStr = futureDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    console.log(`📅 Chèche match ant: ${today} ak ${toDateStr}`);

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

            const formattedMatches = data.matches.map(item => {
                const code = item.competition.code || 'ALL';

                return {
                    id: item.id,
                    league_code: code,
                    league_name: item.competition.name,
                    match_time: new Date(item.utcDate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }),
                    team_a: item.homeTeam.name,
                    team_b: item.awayTeam.name,
                    victory: `Viktwa ${item.homeTeam.name}`,
                    percent: `${Math.floor(Math.random() * 15) + 78}%`,
                    analysis: 'Analiz spòtif kalkile pa rezo'
                };
            });

            const { error: delErr } = await supabase.from('daily_matches').delete().neq('id', 0);
            if (delErr) console.error("❌ Erè efase nan Supabase:", delErr);

            const { error: insErr } = await supabase.from('daily_matches').insert(formattedMatches);
            if (insErr) {
                console.error("❌ Erè ensèsyon nan Supabase:", insErr);
            } else {
                console.log(`✅ ${formattedMatches.length} match anrejistre nan Supabase!`);
            }
        } else {
            console.log("⚠️ Pa gen okenn match pou peryòd sa a sou Football-Data.org.");
        }
    } catch (err) {
        console.error("❌ Erè nan fonksyon sync la:", err);
    }
}

app.get('/', (req, res) => {
    res.send('BETZONE Backend active');
});

app.listen(PORT, () => {
    console.log(`🚀 Sèvè ap koute sou pò ${PORT}`);
    syncDailyMatches();

    cron.schedule('*/12 * * * *', async () => {
        await syncDailyMatches();
    }, {
        scheduled: true,
        timezone: "America/New_York"
    });
});
