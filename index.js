const express = require('express');
const axios = require('axios');
const app = express();

// ============ CONFIGURAÇÕES ============
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/atendimento-n8n';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos
const PORT = process.env.PORT || 3000;

// Mapeamento dos produtos Kirvano (3 planos CS + 1 plano FAB)
const PRODUCT_MAPPING = {
    // CS - 3 planos diferentes
    '5c1f6390-8999-4740-b16f-51380e1097e4': 'CS',  // CS Plano 1
    '0f393085-4960-4c71-9efe-faee8ba51d3f': 'CS',  // CS Plano 2
    'e2282b4c-878c-4bcd-becb-1977dfd6d2b8': 'CS',  // CS Plano 3
    
    // FAB - 1 plano
    '5288799c-d8e3-48ce-a91d-587814acdee5': 'FAB'  // FAB Único
};

// Instâncias Evolution disponíveis
const INSTANCES = [
    { name: 'GABY01', id: '1CEBB8703497-4F31-B33F-335A4233D2FE' },
    { name: 'GABY02', id: '939E26DEA1FA-40D4-83CE-2BF0B3F795DC' },
    { name: 'GABY03', id: 'F819629B5E33-435B-93BB-091B4C104C12' },
    { name: 'GABY04', id: 'D555A7CBC0B3-425B-8E20-975232BE75F6' },
    { name: 'GABY05', id: 'D97A63B8B05B-430E-98C1-61977A51EC0B' }
];

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let pendingPixOrders = new Map();  // PIX pendentes com timeout
let conversationState = new Map();  // Estado das conversas
let clientInstanceMap = new Map();  // Cliente -> Instância (sticky)
let instanceCounter = 0;
let systemLogs = [];

app.use(express.json());

// ============ FUNÇÕES AUXILIARES ============

// Normalizar número de telefone
function normalizePhone(phone) {
    let cleaned = phone.replace(/\D/g, '');
    
    // Se tem 13 dígitos (55 + DDD + 9 + número), remove o 9
    if (cleaned.length === 13 && cleaned.startsWith('55')) {
        const ddd = cleaned.substring(2, 4);
        const number = cleaned.substring(4);
        if (number.startsWith('9') && number.length === 9) {
            cleaned = '55' + ddd + number.substring(1);
        }
    }
    
    return cleaned;
}

// Obter instância sticky para o cliente
function getInstanceForClient(phone) {
    const normalized = normalizePhone(phone);
    
    if (clientInstanceMap.has(normalized)) {
        return clientInstanceMap.get(normalized);
    }
    
    const instance = INSTANCES[instanceCounter % INSTANCES.length];
    instanceCounter++;
    
    clientInstanceMap.set(normalized, instance.name);
    console.log(`✅ Cliente ${normalized} -> Instância ${instance.name}`);
    
    return instance.name;
}

// Enviar para N8N
async function sendToN8N(eventData) {
    try {
        console.log(`📤 Enviando para N8N:`, eventData.event_type);
        const response = await axios.post(N8N_WEBHOOK_URL, eventData, {
            timeout: 15000
        });
        console.log(`✅ N8N respondeu: ${response.status}`);
        return { success: true };
    } catch (error) {
        console.error(`❌ Erro N8N:`, error.message);
        return { success: false, error: error.message };
    }
}

// ============ WEBHOOK KIRVANO ============
app.post('/webhook/kirvano', async (req, res) => {
    try {
        const data = req.body;
        console.log('\n📨 WEBHOOK KIRVANO:', data.event);
        
        const event = data.event;
        const status = data.status;
        const saleId = data.sale_id;
        const checkoutId = data.checkout_id;
        const customerName = data.customer?.name || 'Cliente';
        const customerPhone = data.customer?.phone_number || '';
        const totalPrice = data.total_price || 'R$ 0,00';
        
        // Normaliza telefone
        const normalizedPhone = normalizePhone(customerPhone);
        
        // Identifica produto pelo offer_id
        let productType = 'UNKNOWN';
        if (data.products && data.products.length > 0) {
            const offerId = data.products[0].offer_id;
            productType = PRODUCT_MAPPING[offerId] || 'UNKNOWN';
            console.log(`📦 Produto: ${productType} (offer_id: ${offerId})`);
        }
        
        // Obtém instância sticky
        const instance = getInstanceForClient(normalizedPhone);
        
        // ========== PIX GERADO ==========
        if (event === 'PIX_GENERATED' && status === 'PENDING') {
            console.log(`⏳ PIX GERADO - ${checkoutId} - ${customerName}`);
            
            // Cria estado da conversa
            conversationState.set(normalizedPhone, {
                order_code: checkoutId,
                product: productType,
                instance: instance,
                original_event: 'pix',
                response_count: 0,
                waiting_for_response: true,
                client_name: customerName,
                pix_url: data.payment?.qrcode_image || ''
            });
            
            // Cria timeout de 7 minutos
            const timeout = setTimeout(async () => {
                console.log(`⏰ TIMEOUT PIX: ${checkoutId}`);
                pendingPixOrders.delete(checkoutId);
                
                // Envia evento pix_timeout para N8N
                const eventData = {
                    event_type: 'pix_timeout',
                    produto: productType,
                    instancia: instance,
                    evento_origem: 'pix',
                    cliente: {
                        nome: customerName.split(' ')[0],
                        telefone: normalizedPhone,
                        nome_completo: customerName
                    },
                    pedido: {
                        codigo: checkoutId,
                        valor: totalPrice,
                        pix_url: data.payment?.qrcode_image || ''
                    },
                    timestamp: new Date().toISOString()
                };
                
                await sendToN8N(eventData);
            }, PIX_TIMEOUT);
            
            // Armazena timeout
            pendingPixOrders.set(checkoutId, {
                timeout: timeout,
                phone: normalizedPhone,
                product: productType
            });
            
            res.json({ success: true, message: 'PIX pendente registrado' });
        }
        
        // ========== VENDA APROVADA ==========
        else if (event === 'PURCHASE_APPROVED' || (event === 'PIX_GENERATED' && status === 'PAID')) {
            console.log(`✅ VENDA APROVADA - ${saleId} - ${customerName}`);
            
            // Cancela timeout se existir
            if (pendingPixOrders.has(checkoutId)) {
                clearTimeout(pendingPixOrders.get(checkoutId).timeout);
                pendingPixOrders.delete(checkoutId);
                console.log(`🗑️ Timeout cancelado para ${checkoutId}`);
            }
            
            // Atualiza/cria estado da conversa
            conversationState.set(normalizedPhone, {
                order_code: saleId || checkoutId,
                product: productType,
                instance: instance,
                original_event: 'aprovada',
                response_count: 0,
                waiting_for_response: true,
                client_name: customerName
            });
            
            // Envia evento venda_aprovada para N8N
            const eventData = {
                event_type: 'venda_aprovada',
                produto: productType,
                instancia: instance,
                evento_origem: 'aprovada',
                cliente: {
                    nome: customerName.split(' ')[0],
                    telefone: normalizedPhone,
                    nome_completo: customerName
                },
                pedido: {
                    codigo: saleId || checkoutId,
                    valor: totalPrice
                },
                timestamp: new Date().toISOString()
            };
            
            await sendToN8N(eventData);
            res.json({ success: true, message: 'Venda aprovada processada' });
        }
        
        else {
            console.log(`⚠️ Evento ignorado: ${event} - ${status}`);
            res.json({ success: true, message: 'Evento ignorado' });
        }
        
    } catch (error) {
        console.error('❌ ERRO:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ WEBHOOK EVOLUTION ============
app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            return res.json({ success: true, message: 'Dados inválidos' });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageContent = messageData.message?.conversation || '';
        const clientNumber = remoteJid.replace('@s.whatsapp.net', '');
        const normalized = normalizePhone(clientNumber);
        
        console.log(`\n📱 Evolution: ${normalized} | FromMe: ${fromMe}`);
        
        // Busca estado da conversa
        let clientState = null;
        let stateKey = null;
        
        // Tenta encontrar com número normalizado
        for (const [phone, state] of conversationState.entries()) {
            if (normalizePhone(phone) === normalized) {
                clientState = state;
                stateKey = phone;
                break;
            }
        }
        
        if (!clientState) {
            console.log(`❓ Cliente ${normalized} não encontrado`);
            return res.json({ success: true, message: 'Cliente não encontrado' });
        }
        
        // Se é mensagem do sistema
        if (fromMe) {
            clientState.waiting_for_response = true;
            console.log(`📤 Sistema enviou mensagem para ${normalized}`);
        }
        // Se é resposta do cliente
        else if (clientState.waiting_for_response && clientState.response_count === 0) {
            console.log(`📥 PRIMEIRA RESPOSTA de ${normalized}: "${messageContent}"`);
            
            clientState.response_count = 1;
            clientState.waiting_for_response = false;
            
            // Envia resposta_01 para N8N
            const eventData = {
                event_type: 'resposta_01',
                produto: clientState.product,
                instancia: clientState.instance,
                evento_origem: clientState.original_event,
                cliente: {
                    telefone: normalized,
                    nome: clientState.client_name.split(' ')[0]
                },
                resposta: {
                    numero: 1,
                    conteudo: messageContent,
                    timestamp: new Date().toISOString()
                },
                pedido: {
                    codigo: clientState.order_code,
                    billet_url: clientState.pix_url || ''
                },
                timestamp: new Date().toISOString()
            };
            
            await sendToN8N(eventData);
            conversationState.set(stateKey, clientState);
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('❌ ERRO Evolution:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ ENDPOINTS DE STATUS ============
app.get('/status', (req, res) => {
    const pending = Array.from(pendingPixOrders.entries()).map(([code, data]) => ({
        code: code,
        phone: data.phone,
        product: data.product
    }));
    
    const conversations = Array.from(conversationState.entries()).map(([phone, state]) => ({
        phone: phone,
        order_code: state.order_code,
        product: state.product,
        instance: state.instance,
        response_count: state.response_count,
        waiting_for_response: state.waiting_for_response,
        original_event: state.original_event
    }));
    
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        pending_pix: pending.length,
        active_conversations: conversations.length,
        pending_list: pending,
        conversations_list: conversations,
        instances: INSTANCES.length,
        n8n_webhook: N8N_WEBHOOK_URL
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ INTERFACE WEB (PAINEL) ============
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <title>Cérebro Kirvano - Painel de Controle</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container { 
            max-width: 1400px; 
            margin: 0 auto; 
        }
        
        .header {
            background: white;
            border-radius: 20px;
            padding: 30px;
            margin-bottom: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        
        h1 { 
            color: #333; 
            font-size: 2.5rem; 
            margin-bottom: 10px;
            background: linear-gradient(135deg, #667eea, #764ba2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        
        .subtitle {
            color: #666;
            font-size: 1rem;
            margin-bottom: 20px;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card { 
            background: white;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.08);
        }
        
        .stat-card.warning { border-left: 4px solid #ed8936; }
        .stat-card.info { border-left: 4px solid #4299e1; }
        .stat-card.success { border-left: 4px solid #48bb78; }
        
        .stat-label {
            font-size: 0.9rem;
            color: #718096;
            margin-bottom: 10px;
            text-transform: uppercase;
        }
        
        .stat-value {
            font-size: 2.5rem;
            font-weight: 700;
            color: #2d3748;
        }
        
        .content-panel {
            background: white;
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        
        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            border-bottom: 2px solid #f7fafc;
        }
        
        .tab {
            padding: 12px 24px;
            background: none;
            border: none;
            color: #718096;
            font-weight: 600;
            cursor: pointer;
            position: relative;
        }
        
        .tab.active {
            color: #667eea;
        }
        
        .tab.active::after {
            content: '';
            position: absolute;
            bottom: -2px;
            left: 0;
            right: 0;
            height: 2px;
            background: #667eea;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
        }
        
        th {
            background: #f7fafc;
            padding: 12px;
            text-align: left;
            font-weight: 600;
            color: #2d3748;
            font-size: 0.9rem;
        }
        
        td {
            padding: 12px;
            border-bottom: 1px solid #f7fafc;
            font-size: 0.95rem;
        }
        
        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.8rem;
            font-weight: 600;
        }
        
        .badge-success { background: #c6f6d5; color: #22543d; }
        .badge-warning { background: #fbd38d; color: #975a16; }
        .badge-info { background: #bee3f8; color: #2c5282; }
        
        .btn {
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
            border: none;
            padding: 12px 25px;
            border-radius: 25px;
            cursor: pointer;
            font-weight: 600;
            margin-right: 10px;
        }
        
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 25px rgba(102, 126, 234, 0.4);
        }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: #718096;
        }
        
        .config-info {
            background: #f7fafc;
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 20px;
        }
        
        .config-item {
            display: flex;
            justify-content: space-between;
            padding: 5px 0;
            border-bottom: 1px solid #e2e8f0;
        }
        
        .config-item:last-child {
            border-bottom: none;
        }
        
        .config-label {
            color: #718096;
            font-weight: 600;
        }
        
        .config-value {
            color: #2d3748;
            font-family: monospace;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🧠 Cérebro Kirvano</h1>
            <div class="subtitle">Sistema de Gestão de Leads - Versão 2.0 Simplificada</div>
            
            <div class="config-info">
                <div class="config-item">
                    <span class="config-label">N8N Webhook:</span>
                    <span class="config-value">${N8N_WEBHOOK_URL}</span>
                </div>
                <div class="config-item">
                    <span class="config-label">Timeout PIX:</span>
                    <span class="config-value">7 minutos</span>
                </div>
                <div class="config-item">
                    <span class="config-label">Produtos:</span>
                    <span class="config-value">CS (3 planos) | FAB (1 plano)</span>
                </div>
                <div class="config-item">
                    <span class="config-label">Horário:</span>
                    <span class="config-value">${new Date().toLocaleString('pt-BR')}</span>
                </div>
            </div>
            
            <div class="stats-grid" id="stats">
                <div class="stat-card warning">
                    <div class="stat-label">⏳ PIX Pendentes</div>
                    <div class="stat-value" id="pendingPix">0</div>
                </div>
                
                <div class="stat-card info">
                    <div class="stat-label">💬 Conversas Ativas</div>
                    <div class="stat-value" id="activeConv">0</div>
                </div>
                
                <div class="stat-card success">
                    <div class="stat-label">🚀 Instâncias</div>
                    <div class="stat-value">${INSTANCES.length}</div>
                </div>
            </div>
            
            <button class="btn" onclick="refreshData()">🔄 Atualizar</button>
            <button class="btn" onclick="clearData()">🗑️ Limpar Dados</button>
        </div>
        
        <div class="content-panel">
            <div class="tabs">
                <button class="tab active" onclick="switchTab('pending')">PIX Pendentes</button>
                <button class="tab" onclick="switchTab('conversations')">Conversas Ativas</button>
                <button class="tab" onclick="switchTab('config')">Configuração</button>
            </div>
            
            <div id="tabContent">
                <div class="empty-state">
                    <p>Carregando dados...</p>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        let currentTab = 'pending';
        let statusData = null;
        
        async function refreshData() {
            try {
                const response = await fetch('/status');
                statusData = await response.json();
                
                document.getElementById('pendingPix').textContent = statusData.pending_pix;
                document.getElementById('activeConv').textContent = statusData.active_conversations;
                
                updateTabContent();
            } catch (error) {
                console.error('Erro ao carregar dados:', error);
            }
        }
        
        function switchTab(tab) {
            currentTab = tab;
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            event.target.classList.add('active');
            updateTabContent();
        }
        
        function updateTabContent() {
            const content = document.getElementById('tabContent');
            
            if (!statusData) {
                content.innerHTML = '<div class="empty-state"><p>Carregando...</p></div>';
                return;
            }
            
            if (currentTab === 'pending') {
                if (statusData.pending_list.length === 0) {
                    content.innerHTML = '<div class="empty-state"><p>Nenhum PIX pendente no momento</p></div>';
                } else {
                    let html = '<table><thead><tr><th>Código</th><th>Telefone</th><th>Produto</th></tr></thead><tbody>';
                    statusData.pending_list.forEach(item => {
                        html += '<tr>';
                        html += '<td>' + item.code + '</td>';
                        html += '<td>' + item.phone + '</td>';
                        html += '<td><span class="badge badge-' + (item.product === 'FAB' ? 'warning' : 'info') + '">' + item.product + '</span></td>';
                        html += '</tr>';
                    });
                    html += '</tbody></table>';
                    content.innerHTML = html;
                }
            } else if (currentTab === 'conversations') {
                if (statusData.conversations_list.length === 0) {
                    content.innerHTML = '<div class="empty-state"><p>Nenhuma conversa ativa</p></div>';
                } else {
                    let html = '<table><thead><tr><th>Telefone</th><th>Pedido</th><th>Produto</th><th>Instância</th><th>Respostas</th><th>Status</th></tr></thead><tbody>';
                    statusData.conversations_list.forEach(conv => {
                        html += '<tr>';
                        html += '<td>' + conv.phone + '</td>';
                        html += '<td>' + conv.order_code + '</td>';
                        html += '<td><span class="badge badge-' + (conv.product === 'FAB' ? 'warning' : 'info') + '">' + conv.product + '</span></td>';
                        html += '<td>' + conv.instance + '</td>';
                        html += '<td>' + conv.response_count + '</td>';
                        html += '<td><span class="badge badge-' + (conv.waiting_for_response ? 'warning' : 'success') + '">' + (conv.waiting_for_response ? 'Aguardando' : 'Respondido') + '</span></td>';
                        html += '</tr>';
                    });
                    html += '</tbody></table>';
                    content.innerHTML = html;
                }
            } else if (currentTab === 'config') {
                content.innerHTML = \`
                    <div style="padding: 20px;">
                        <h3>Endpoints do Sistema</h3>
                        <ul style="margin: 20px 0; line-height: 2;">
                            <li><strong>Webhook Kirvano:</strong> \${window.location.origin}/webhook/kirvano</li>
                            <li><strong>Webhook Evolution:</strong> \${window.location.origin}/webhook/evolution</li>
                            <li><strong>Status API:</strong> \${window.location.origin}/status</li>
                            <li><strong>Health Check:</strong> \${window.location.origin}/health</li>
                        </ul>
                        <h3>Produtos Configurados</h3>
                        <ul style="margin: 20px 0; line-height: 2;">
                            <li><strong>CS:</strong> 3 planos mapeados</li>
                            <li><strong>FAB:</strong> 1 plano mapeado</li>
                        </ul>
                    </div>
                \`;
            }
        }
        
        function clearData() {
            if (confirm('Deseja limpar todos os dados em memória?')) {
                alert('Função ainda não implementada');
            }
        }
        
        // Auto-refresh a cada 5 segundos
        refreshData();
        setInterval(refreshData, 5000);
    </script>
</body>
</html>`;
    
    res.send(html);
});

// ============ INICIALIZAÇÃO ============
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════╗
║   🧠 CÉREBRO KIRVANO v2.0 SIMPLES   ║
╚══════════════════════════════════════╝
📡 Webhooks:
   • Kirvano: /webhook/kirvano
   • Evolution: /webhook/evolution
   
📊 Status: /status
🏥 Health: /health

🎯 N8N: ${N8N_WEBHOOK_URL}
⏱️ Timeout PIX: 7 minutos
🚀 Porta: ${PORT}
════════════════════════════════════════`);
});
