const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const PORT = process.env.PORT || 5000;
const DB_FILE = path.join(__dirname, 'devices.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Shop & Owner Settings
let settings = {
    ownerName: "Muhammad Farooq",
    shopName: "Farooq Mobile Center",
    shopPhone: "+92 300 1234567",
    emergencyPhone: "1122",
    address: "Main Mobile Market"
};

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
            settings = { ...settings, ...JSON.parse(data) };
        } else {
            saveSettings();
        }
    } catch (err) {
        console.error("Error loading settings:", err);
    }
}

function saveSettings() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    } catch (err) {
        console.error("Error saving settings:", err);
    }
}

// In-memory + JSON persistence for devices
let devices = [];
function loadDevices() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            devices = JSON.parse(data);
        } else {
            // Seed with sample initial records
            devices = [
                {
                    id: "DEV-1001",
                    customerName: "Ali Khan",
                    customerPhone: "+92 301 2345678",
                    phoneModel: "Redmi Note 12",
                    imei: "867492048291047",
                    status: "ACTIVE", // ACTIVE or LOCKED
                    ownerName: "Farooq Mobile Center",
                    ownerPhone: "+92 300 1234567",
                    createdAt: new Date().toISOString(),
                    isOnline: false
                },
                {
                    id: "DEV-1002",
                    customerName: "Muhammad Usman",
                    customerPhone: "+92 321 7654321",
                    phoneModel: "Infinix Hot 30",
                    imei: "867492048291089",
                    status: "LOCKED",
                    ownerName: "Farooq Mobile Center",
                    ownerPhone: "+92 300 1234567",
                    createdAt: new Date().toISOString(),
                    isOnline: false
                },
                {
                    id: "DEV-1003",
                    customerName: "Zubair Ahmed",
                    customerPhone: "+92 333 5551234",
                    phoneModel: "Tecno Spark 10 Pro",
                    imei: "867492048291033",
                    status: "ACTIVE",
                    ownerName: "Farooq Mobile Center",
                    ownerPhone: "+92 300 1234567",
                    createdAt: new Date().toISOString(),
                    isOnline: false
                }
            ];
            saveDevices();
        }
    } catch (err) {
        console.error("Error loading database:", err);
        devices = [];
    }
}

function saveDevices() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(devices, null, 2), 'utf8');
    } catch (err) {
        console.error("Error saving database:", err);
    }
}

function getApkChecksum() {
    const apkPath = path.join(__dirname, 'public', 'Customer_Device_Lock_App.apk');
    if (fs.existsSync(apkPath)) {
        const fileBuffer = fs.readFileSync(apkPath);
        return crypto.createHash('sha256').update(fileBuffer).digest('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }
    return "";
}

loadSettings();
loadDevices();

// Connected WebSockets Map: deviceId -> WebSocket
const socketClients = new Map();

wss.on('connection', (ws, req) => {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const deviceId = urlParams.get('deviceId');

    if (deviceId) {
        socketClients.set(deviceId, ws);
        console.log(`Device connected via WebSocket: ${deviceId}`);

        // Update online status in database
        const dev = devices.find(d => d.id === deviceId);
        if (dev) {
            dev.isOnline = true;
            saveDevices();
        }
    }

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`Received from ${deviceId}:`, data);

            if (data.type === 'HEARTBEAT' && data.deviceId) {
                const dev = devices.find(d => d.id === data.deviceId);
                if (dev) {
                    dev.isOnline = true;
                    if (data.model) dev.phoneModel = data.model;
                    saveDevices();
                }
            }
        } catch (err) {
            console.error('WebSocket message parse error:', err);
        }
    });

    ws.on('close', () => {
        if (deviceId) {
            socketClients.delete(deviceId);
            const dev = devices.find(d => d.id === deviceId);
            if (dev) {
                dev.isOnline = false;
                saveDevices();
            }
            console.log(`Device disconnected: ${deviceId}`);
        }
    });
});

// REST APIs for Owner Mobile App & Web Controller

// 0. Shop & Owner Settings API
app.get('/api/settings', (req, res) => {
    res.json(settings);
});

app.post('/api/settings', (req, res) => {
    const { ownerName, shopName, shopPhone, emergencyPhone, address } = req.body;
    if (ownerName !== undefined) settings.ownerName = ownerName.trim();
    if (shopName !== undefined) settings.shopName = shopName.trim();
    if (shopPhone !== undefined) settings.shopPhone = shopPhone.trim();
    if (emergencyPhone !== undefined) settings.emergencyPhone = emergencyPhone.trim();
    if (address !== undefined) settings.address = address.trim();

    saveSettings();
    console.log(`[SETTINGS UPDATED] Owner: "${settings.ownerName}", Shop: "${settings.shopName}", Phone: "${settings.shopPhone}"`);
    res.json({
        success: true,
        message: "Dukan ki details kamyabi se update ho gayin!",
        settings
    });
});

// 1. Get all customer devices (with search)
app.get('/api/devices', (req, res) => {
    const { search } = req.query;
    let result = devices;

    if (search) {
        const q = search.toLowerCase();
        result = result.filter(d =>
            d.customerName.toLowerCase().includes(q) ||
            d.customerPhone.toLowerCase().includes(q) ||
            d.id.toLowerCase().includes(q) ||
            (d.phoneModel && d.phoneModel.toLowerCase().includes(q)) ||
            (d.imei && d.imei.toLowerCase().includes(q))
        );
    }

    // Refresh online status based on socket map
    result = result.map(d => ({
        ...d,
        isOnline: socketClients.has(d.id)
    }));

    res.json(result);
});

// 2. Add new customer device
app.post('/api/devices/add', async (req, res) => {
    const { customerName, customerPhone, phoneModel, imei, ownerName, ownerPhone } = req.body;

    if (!customerName || !customerPhone) {
        return res.status(400).json({ error: "Customer Name aur Phone Number zaroori hai!" });
    }

    const newId = `DEV-${Math.floor(1000 + Math.random() * 9000)}`;

    const newDevice = {
        id: newId,
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        phoneModel: (phoneModel || "Generic Android").trim(),
        imei: (imei || "Not specified").trim(),
        status: "ACTIVE",
        ownerName: (ownerName || settings.shopName || settings.ownerName).trim(),
        ownerPhone: (ownerPhone || settings.shopPhone).trim(),
        createdAt: new Date().toISOString(),
        isOnline: false
    };

    devices.unshift(newDevice);
    saveDevices();

    // Android Enterprise standard QR provisioning payload
    const checksum = getApkChecksum();
    const localIp = getLocalIp();
    const rawHost = req.get('host');
    const host = (rawHost && !rawHost.includes('localhost') && !rawHost.includes('127.0.0.1')) 
        ? rawHost 
        : `${localIp}:${PORT}`;
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';

    const qrPayload = {
        "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_NAME": "com.installment.mdm",
        "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": "com.installment.mdm/.AdminReceiver",
        "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION": `${protocol}://${host}/Customer_Device_Lock_App.apk`,
        "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE": {
            "deviceId": newId,
            "customerName": newDevice.customerName,
            "ownerName": newDevice.ownerName,
            "ownerPhone": newDevice.ownerPhone,
            "emergencyPhone": settings.emergencyPhone || "1122",
            "serverUrl": `ws://${host}/ws`
        }
    };

    if (checksum) {
        qrPayload["android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM"] = checksum;
    }

    try {
        const qrCodeDataUrl = await QRCode.toDataURL(JSON.stringify(qrPayload));
        res.json({
            message: "Customer kamyabi se add ho gaya!",
            device: newDevice,
            qrCodeDataUrl,
            qrPayload
        });
    } catch (err) {
        res.status(500).json({ error: "QR code generate karne mein masla hua" });
    }
});

// 3. LOCK DEVICE (Immediate trigger)
app.post('/api/devices/:id/lock', (req, res) => {
    const { id } = req.params;
    const dev = devices.find(d => d.id === id);

    if (!dev) {
        return res.status(404).json({ error: "Device record nahi mila!" });
    }

    dev.status = "LOCKED";
    // Sync current shop details to the device
    if (settings.shopName) dev.ownerName = settings.shopName;
    if (settings.shopPhone) dev.ownerPhone = settings.shopPhone;
    saveDevices();

    // Push via WebSocket if connected
    const ws = socketClients.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            action: "LOCK",
            ownerName: dev.ownerName,
            ownerPhone: dev.ownerPhone,
            emergencyPhone: settings.emergencyPhone || "1122"
        }));
    }

    console.log(`[LOCK SENT] Device ${id} (${dev.customerName}) has been LOCKED! (Shop: ${dev.ownerName})`);
    res.json({
        success: true,
        message: `${dev.customerName} ka phone LOCK kar diya gaya hai!`,
        isOnline: !!(ws && ws.readyState === WebSocket.OPEN)
    });
});

// 4. UNLOCK DEVICE (Immediate trigger)
app.post('/api/devices/:id/unlock', (req, res) => {
    const { id } = req.params;
    const dev = devices.find(d => d.id === id);

    if (!dev) {
        return res.status(404).json({ error: "Device record nahi mila!" });
    }

    dev.status = "ACTIVE";
    saveDevices();

    const ws = socketClients.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            action: "UNLOCK"
        }));
    }

    console.log(`[UNLOCK SENT] Device ${id} (${dev.customerName}) has been UNLOCKED!`);
    res.json({
        success: true,
        message: `${dev.customerName} ka phone UNLOCK kar diya gaya hai!`,
        isOnline: !!(ws && ws.readyState === WebSocket.OPEN)
    });
});

// 5. PERMANENT RELEASE / DELETE (Clears Device Owner and restores phone)
app.post('/api/devices/:id/release', (req, res) => {
    const { id } = req.params;
    const index = devices.findIndex(d => d.id === id);

    if (index === -1) {
        return res.status(404).json({ error: "Device record nahi mila!" });
    }

    const dev = devices[index];

    // Send RELEASE command to phone
    const ws = socketClients.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            action: "RELEASE"
        }));
    }

    // Remove from database
    devices.splice(index, 1);
    saveDevices();

    console.log(`[RELEASE SENT] Device ${id} (${dev.customerName}) settled & permanently removed!`);
    res.json({
        success: true,
        message: `${dev.customerName} ki qistein poori ho gayin! Phone se MDM restrictions khatam kar di gayi hain.`
    });
});

server.listen(PORT, '0.0.0.0', () => {
    const localIp = getLocalIp();
    console.log(`=======================================================`);
    console.log(`🚀 Dukan MDM Backend Server is RUNNING!`);
    console.log(`📱 Owner Mobile App URL:   http://${localIp}:${PORT}`);
    console.log(`💻 Local Computer Web URL: http://localhost:${PORT}`);
    console.log(`📲 Customer APK Direct:    http://${localIp}:${PORT}/Customer_Device_Lock_App.apk`);
    console.log(`=======================================================`);
});
