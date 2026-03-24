const PARK_IDS = {
  'Magic Kingdom': '6',
  'EPCOT': '5',
  'Hollywood Studios': '7',
  'Animal Kingdom': '8',
  'Universal Studios Florida': '13',
  'Islands of Adventure': '14',
  'Epic Universe': '687',
  'Legoland': '13261',
};

async function fetchWaitTimes(parkName) {
  if (!parkName) return null;
  const pLower = parkName.toLowerCase();
  let id = null;
  for (const [k, v] of Object.entries(PARK_IDS)) {
    if (pLower.includes(k.toLowerCase()) || k.toLowerCase().includes(pLower)) {
      id = v; break;
    }
  }
  if (!id) return null;
  try {
    const r = await fetch(`https://queue-times.com/parks/${id}/queue_times.json`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Florida2026-Copilot/1.0' }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.error('Queue Times fetch error:', e.message);
    return null;
  }
}

function buildWaitSummary(data) {
  if (!data?.lands?.length) return null;
  const lines = [];
  for (const land of data.lands) {
    for (const ride of land.rides) {
      const wait = !ride.is_open ? 'FECHADA' : ride.wait_time === 0 ? 'Walk-in' : `${ride.wait_time}min`;
      lines.push(`${ride.name}: ${wait}`);
    }
  }
  return lines.join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key não configurada' });

  try {
    const { messages, system, parkName, fetchWaits } = req.body;

    // Buscar filas no servidor (sem CORS)
    let waitData = null;
    let waitSummary = null;
    let waitCard = null;

    if (fetchWaits && parkName) {
      waitData = await fetchWaitTimes(parkName);
      if (waitData?.lands?.length) {
        waitSummary = buildWaitSummary(waitData);

        // Montar card visual
        const now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
        const rides = waitData.lands.flatMap(l => l.rides);
        rides.sort((a, b) => (b.is_open - a.is_open) || (b.wait_time - a.wait_time));
        const top = rides.slice(0, 12);
        let card = `<div class="wcard"><div class="wcard-title">● AO VIVO — ${parkName} · ${now} (Orlando)</div>`;
        for (const r of top) {
          const cls = !r.is_open ? 'wo' : r.wait_time <= 20 ? 'wl' : r.wait_time <= 45 ? 'wm' : 'wh';
          const wt = !r.is_open ? 'Fechada' : r.wait_time === 0 ? 'Walk-in' : `${r.wait_time}min`;
          card += `<div class="wi"><span>${r.name}</span><span class="wb ${cls}">${wt}</span></div>`;
        }
        card += '</div>';
        waitCard = card;
      }
    }

    // Injetar dados de fila nas mensagens se disponível
    let finalMessages = messages;
    if (waitSummary) {
      const now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
      const lastMsg = messages[messages.length - 1];
      finalMessages = [
        ...messages.slice(0, -1),
        {
          role: 'user',
          content: lastMsg.content + `\n\n[DADOS AO VIVO — ${parkName} às ${now} horário de Orlando]\n${waitSummary}`
        }
      ];
    } else if (fetchWaits && parkName) {
      const lastMsg = messages[messages.length - 1];
      finalMessages = [
        ...messages.slice(0, -1),
        {
          role: 'user',
          content: lastMsg.content + `\n\n[DADOS AO VIVO: API da Queue Times não retornou dados para ${parkName} neste momento. Pode ser instabilidade temporária da API.]`
        }
      ];
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system,
        messages: finalMessages,
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Erro' });

    return res.status(200).json({
      text: data.content[0].text,
      waitCard: waitCard || null,
      hasLiveData: !!waitSummary,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
