const axios = require("axios");
const md5 = require("md5");
const Tesseract = require("tesseract.js");

const SECRET = "tB87#kPtkxqOS2";

// =========================
// BOT OWNER DISCORD USER ID
// Used to DM captcha images when OCR fails.
// =========================
const OWNER_DISCORD_ID = "724665716636385310";

// =========================
// RATE LIMIT
// WOS API allows ~30 requests/min.
// This delay is applied between each player to stay safe.
// =========================
const DELAY_BETWEEN_PLAYERS_MS = 2000; // 2 seconds = 30 players/min max

const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://wos-giftcode.centurygame.com",
    "Referer": "https://wos-giftcode.centurygame.com/",
    "sec-ch-ua":
        '"Not:A-Brand";v="99", "Google Chrome";v="134", "Chromium";v="134"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sign formula for /api/player (login):
//   md5("fid={fid}&time={ts}{SECRET}")
function makeLoginSign(fid, ts) {
    return md5(`fid=${fid}&time=${ts}${SECRET}`);
}

// Sign formula for /api/gift_code (redemption) — DIFFERENT from login:
//   md5("cdk={code}&fid={fid}&time={ts}{SECRET}")
function makeRedeemSign(fid, ts, code) {
    return md5(`cdk=${code}&fid=${fid}&time=${ts}${SECRET}`);
}

// =========================================
// STEP 1 — Login (required before redeeming)
// =========================================
async function loginPlayer(fid) {
    const ts = Date.now();
    const sign = makeLoginSign(fid, ts);

    const res = await axios.post(
        "https://wos-giftcode-api.centurygame.com/api/player",
        `fid=${fid}&time=${ts}&sign=${sign}`,
        { headers }
    );

    const data = res.data;
    console.log(`[${fid}] Login response:`, JSON.stringify(data));

    if (data?.msg !== "success") {
        throw new Error(`Login failed for player ${fid}: ${data?.msg}`);
    }
}

// =========================================
// STEP 2 — Fetch captcha (fresh ts+sign each time)
// =========================================
async function fetchCaptcha(fid) {
    const ts = Date.now();
    const sign = makeLoginSign(fid, ts); // captcha uses the same sign format as login

    const res = await axios.post(
        "https://wos-giftcode-api.centurygame.com/api/captcha",
        `fid=${fid}&time=${ts}&sign=${sign}`,
        { headers }
    );

    const captchaBase64 = res.data?.data?.img;
    if (!captchaBase64) {
        throw new Error(`Captcha response missing image: ${JSON.stringify(res.data)}`);
    }

    return { captchaBase64, ts, sign };
}

// =========================================
// STEP 3a — Solve captcha with OCR
// =========================================
async function solveCaptchaOCR(base64Image) {
    const imageBuffer = Buffer.from(base64Image, "base64");
    const result = await Tesseract.recognize(imageBuffer, "eng", {
        logger: () => {}
    });
    return result.data.text.replace(/[^a-zA-Z0-9]/g, "").trim();
}

// =========================================
// STEP 3b — Solve captcha manually via DM
// =========================================
async function askOwnerForCaptcha(discordClient, fid, captchaBase64, giftCode) {
    const { AttachmentBuilder } = require("discord.js");

    const owner = await discordClient.users.fetch(OWNER_DISCORD_ID);
    const dmChannel = await owner.createDM();

    const imageBuffer = Buffer.from(captchaBase64, "base64");
    const attachment = new AttachmentBuilder(imageBuffer, { name: "captcha.png" });

    await dmChannel.send({
        content: `🔐 **Manual captcha needed**\nPlayer ID: \`${fid}\` | Gift code: \`${giftCode}\`\nPlease reply with the captcha text (case insensitive):`,
        files: [attachment]
    });

    console.log(`[${fid}] Waiting for manual captcha from owner...`);

    return new Promise((resolve) => {
        const collector = dmChannel.createMessageCollector({
            filter: (m) => m.author.id === OWNER_DISCORD_ID,
            max: 1
            // No timeout — waits indefinitely
        });

        collector.on("collect", (m) => {
            const code = m.content.replace(/[^a-zA-Z0-9]/g, "").trim();
            console.log(`[${fid}] Owner provided captcha: "${code}"`);
            resolve(code);
        });
    });
}

// =========================================
// STEP 4 — Submit gift code redemption
// =========================================
async function submitRedemption(fid, giftCode, captchaCode, ts, sign) {
    // Note: redemption uses its OWN sign (cdk+fid+time formula), not the captcha sign
    const redeemSign = makeRedeemSign(fid, ts, giftCode);

    const res = await axios.post(
        "https://wos-giftcode-api.centurygame.com/api/gift_code",
        `fid=${fid}&cdk=${giftCode}&captcha_code=${captchaCode}&time=${ts}&sign=${redeemSign}`,
        { headers }
    );

    return res.data;
}

// =========================================
// MAIN — redeemCode
// =========================================
async function redeemCode(fid, giftCode, discordClient) {
    console.log(`[${fid}] Starting redemption for code: ${giftCode}`);

    // Rate limit courtesy delay
    await sleep(DELAY_BETWEEN_PLAYERS_MS);

    // --- STEP 1: Login ---
    try {
        await loginPlayer(fid);
    } catch (err) {
        console.log(`[${fid}] Login error: ${err.message}`);
        return { success: false, message: err.message };
    }

    // --- STEPS 2+3+4: Captcha + Redeem, OCR first ---
    const OCR_MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= OCR_MAX_ATTEMPTS; attempt++) {
        try {
            console.log(`[${fid}] OCR attempt ${attempt}/${OCR_MAX_ATTEMPTS}...`);

            const { captchaBase64, ts } = await fetchCaptcha(fid);
            const captchaCode = await solveCaptchaOCR(captchaBase64);

            if (!captchaCode || captchaCode.length < 3) {
                console.log(`[${fid}] OCR bad result ("${captchaCode}"), retrying...`);
                continue;
            }

            console.log(`[${fid}] OCR result: "${captchaCode}"`);

            const data = await submitRedemption(fid, giftCode, captchaCode, ts, null);
            console.log(`[${fid}] API response:`, JSON.stringify(data));

            const errCode = data?.err_code ?? data?.code;

            if (errCode === 40008) {
                console.log(`[${fid}] Wrong captcha (OCR), retrying...`);
                continue;
            }

            // err_code 20000 = success, 40007 = already redeemed, 40014 = invalid/expired code
            return {
                success: errCode === 20000,
                message: data?.msg || data?.message || JSON.stringify(data)
            };

        } catch (err) {
            console.log(`[${fid}] OCR attempt ${attempt} error:`, err.response?.data || err.message);
        }
    }

    // --- FALLBACK: Manual captcha via DM ---
    if (!discordClient || !OWNER_DISCORD_ID) {
        console.log(`[${fid}] OCR failed and manual fallback not configured. Skipping.`);
        return { success: false, message: "OCR failed and manual fallback is not configured." };
    }

    try {
        console.log(`[${fid}] OCR failed 3 times — requesting manual captcha via DM...`);

        const { captchaBase64, ts } = await fetchCaptcha(fid);
        const manualCode = await askOwnerForCaptcha(discordClient, fid, captchaBase64, giftCode);

        if (!manualCode || manualCode.length < 3) {
            return { success: false, message: "Manual captcha input was empty or invalid." };
        }

        const data = await submitRedemption(fid, giftCode, manualCode, ts, null);
        console.log(`[${fid}] API response (manual):`, JSON.stringify(data));

        const errCode = data?.err_code ?? data?.code;

        return {
            success: errCode === 20000,
            message: data?.msg || data?.message || JSON.stringify(data)
        };

    } catch (err) {
        console.log(`[${fid}] Manual captcha redemption error:`, err.response?.data || err.message);
        return { success: false, message: err.response?.data?.msg || err.message };
    }
}

module.exports = redeemCode;
