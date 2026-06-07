const { Client, GatewayIntentBits, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
require('dotenv').config();
const { MongoClient } = require('mongodb');

// ======================
// 📦 MONGODB CONNECTION
// ======================
const mongoClient = new MongoClient(process.env.MONGO_URI, {
  tls: true,
  tlsAllowInvalidCertificates: true,
});
let profilesCollection;   // global user profiles
let serverLinksCollection; // which profiles are linked to which servers

async function connectDB() {
  try {
    await mongoClient.connect();
    console.log("✅ Conectado ao MongoDB!");
    const db = mongoClient.db("puzzleBotDB");
    profilesCollection   = db.collection("profiles");
    serverLinksCollection = db.collection("serverLinks");
  } catch (err) {
    console.error("❌ Erro ao conectar ao MongoDB:", err);
    process.exit(1);
  }
}

// ======================
// 🔄 MIGRATION (old → new structure)
// ======================
async function runMigrations() {
  // Old structure was stored in "serversMemory" collection
  const oldCollection = mongoClient.db("puzzleBotDB").collection("serversMemory");
  const oldDoc = await oldCollection.findOne({ key: 'servers' });
  if (!oldDoc || !oldDoc.data || Object.keys(oldDoc.data).length === 0) return;

  // Check if migration already ran
  const alreadyMigrated = await profilesCollection.findOne({ _migratedFromLegacy: true });
  if (alreadyMigrated) return;

  console.log("🔄 Migrating legacy data to new profile structure...");
  let migratedUsers = 0;

  for (const [guildId, guild] of Object.entries(oldDoc.data)) {
    for (const [userId, userData] of Object.entries(guild.users || {})) {

      // Migrate ColdHighways → FrostwindTrack while we're at it
      for (const type of ['have', 'need']) {
        if (userData[type]?.BalladOfWindAndCold?.ColdHighways) {
          userData[type].BalladOfWindAndCold.FrostwindTrack = userData[type].BalladOfWindAndCold.ColdHighways;
          delete userData[type].BalladOfWindAndCold.ColdHighways;
        }
      }

      const profileName = 'Main';
      const now = Date.now();

      // Upsert profile
      await profilesCollection.updateOne(
        { userId },
        {
          $set: {
            [`profiles.${profileName}.have`]: userData.have || {},
            [`profiles.${profileName}.need`]: userData.need || {},
            [`profiles.${profileName}.haveUpdated`]: userData.haveUpdated || now,
            [`profiles.${profileName}.needUpdated`]: userData.needUpdated || now,
            [`profiles.${profileName}.lastReminder`]: userData.lastReminder || 0,
            _migratedFromLegacy: true
          }
        },
        { upsert: true }
      );

      // Link profile to server
      await serverLinksCollection.updateOne(
        { guildId },
        {
          $set: {
            [`members.${userId}.linkedProfiles`]: [profileName],
            [`members.${userId}.lastUsedProfile`]: profileName
          }
        },
        { upsert: true }
      );

      migratedUsers++;
    }
  }

  // Mark migration done
  await profilesCollection.updateOne(
    { _migratedFromLegacy: true },
    { $set: { _migratedFromLegacy: true } },
    { upsert: true }
  );

  console.log(`✅ Migration complete: ${migratedUsers} users migrated with profile "Main"`);
}

// ======================
// 📦 DISCORD CLIENT
// ======================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// ======================
// 📦 IN-MEMORY DATA
// ======================
const sessions = {}; // { `${guildId}:${userId}`: { ... } }
const pendingTrades = {};

// ======================
// 📚 ALBUMS
// ======================
const albumsData = {
  BalladOfWindAndCold: {
    HonorAndGlory: 12,
    FrostwindTrack: 14,
    WordsOfTheForgotten: 14,
    MonumentToTheFlames: 13,
    AllianceShowdown: 12,
    StateVersusState: 14,
    TheSummitOfBattle: 12,
    CastleOfConflict: 12,
    RemakerOfOrder: 11
  },
  KingsOfCombat: {
    LeagueOfHonor: 12,
    ATournamentOfHeroes: 14,
    DuelOfGreatness: 14,
    TheCallisto: 13,
    KingsOfCombat: 12,
    TheArenaGamers: 13,
    TheHeliosCannon: 13,
    Behemoth: 11,
    TheBellTolls: 12
  },
  FrostdragonEmpire: {
    FrostdragonEmpire: 12,
    TheDragonicLegend: 14,
    WingsOfEmpire: 14,
    TheDragonicLegion: 13,
    Rediscovery: 12,
    FutureVision: 14,
    WarAndWealth: 12,
    BanquetForAKing: 12,
    ATyrantCrowned: 11
  }
};

// ======================
// 🏷️ DISPLAY NAMES
// ======================
const displayNames = {
  BalladOfWindAndCold: 'Ballad of Wind and Cold',
  KingsOfCombat: 'Kings of Combat',
  FrostdragonEmpire: 'Frostdragon Empire',
  HonorAndGlory: 'Honor and Glory',
  FrostwindTrack: 'Frostwind Track',
  WordsOfTheForgotten: 'Words of the Forgotten',
  MonumentToTheFlames: 'Monument to the Flames',
  AllianceShowdown: 'Alliance Showdown',
  StateVersusState: 'State Versus State',
  TheSummitOfBattle: 'The Summit of Battle',
  CastleOfConflict: 'Castle of Conflict',
  RemakerOfOrder: 'Remaker of Order',
  LeagueOfHonor: 'League of Honor',
  ATournamentOfHeroes: 'A Tournament of Heroes',
  DuelOfGreatness: 'Duel of Greatness',
  TheCallisto: 'The Callisto',
  TheArenaGamers: 'The Arena Gamers',
  TheHeliosCannon: 'The Helios Cannon',
  Behemoth: 'Behemoth',
  TheBellTolls: 'The Bell Tolls',
  TheDragonicLegend: 'The Dragonic Legend',
  WingsOfEmpire: 'Wings of Empire',
  TheDragonicLegion: 'The Dragonic Legion',
  Rediscovery: 'Rediscovery',
  FutureVision: 'Future Vision',
  WarAndWealth: 'War and Wealth',
  BanquetForAKing: 'Banquet for a King',
  ATyrantCrowned: 'A Tyrant Crowned'
};

function dn(key) { return displayNames[key] || key; }

// ======================
// 💾 PROFILE DB FUNCTIONS
// ======================

function getSession(guildId, userId) {
  const key = `${guildId}:${userId}`;
  if (!sessions[key]) sessions[key] = {};
  return sessions[key];
}

async function getUserDoc(userId) {
  return await profilesCollection.findOne({ userId });
}

async function getServerLink(guildId) {
  return await serverLinksCollection.findOne({ guildId });
}

async function getLinkedProfiles(guildId, userId) {
  const link = await getServerLink(guildId);
  return link?.members?.[userId]?.linkedProfiles || [];
}

async function getLastUsedProfile(guildId, userId) {
  const link = await getServerLink(guildId);
  return link?.members?.[userId]?.lastUsedProfile || null;
}

async function setLastUsedProfile(guildId, userId, profileName) {
  await serverLinksCollection.updateOne(
    { guildId },
    { $set: { [`members.${userId}.lastUsedProfile`]: profileName } },
    { upsert: true }
  );
}

async function linkProfileToServer(guildId, userId, profileName) {
  const link = await getServerLink(guildId);
  const existing = link?.members?.[userId]?.linkedProfiles || [];
  if (!existing.includes(profileName)) existing.push(profileName);
  await serverLinksCollection.updateOne(
    { guildId },
    {
      $set: {
        [`members.${userId}.linkedProfiles`]: existing,
        [`members.${userId}.lastUsedProfile`]: profileName
      }
    },
    { upsert: true }
  );
}

async function renameProfile(userId, oldName, newName) {
  const userDoc = await getUserDoc(userId);
  if (!userDoc?.profiles?.[oldName]) return false;
  const profileData = userDoc.profiles[oldName];
  // Copy to new name, delete old
  await profilesCollection.updateOne(
    { userId },
    {
      $set: { [`profiles.${newName}`]: profileData },
      $unset: { [`profiles.${oldName}`]: '' }
    }
  );
  // Update all server links
  const allLinks = await serverLinksCollection.find({ [`members.${userId}.linkedProfiles`]: oldName }).toArray();
  for (const link of allLinks) {
    const updated = link.members[userId].linkedProfiles.map(p => p === oldName ? newName : p);
    const lastUsed = link.members[userId].lastUsedProfile === oldName ? newName : link.members[userId].lastUsedProfile;
    await serverLinksCollection.updateOne(
      { guildId: link.guildId },
      { $set: { [`members.${userId}.linkedProfiles`]: updated, [`members.${userId}.lastUsedProfile`]: lastUsed } }
    );
  }
  return true;
}

async function getInstantMatches(guildId, userId, profileName) {
  const myProfile = await getProfile(userId, profileName);
  if (!myProfile) return null;
  const allServerProfiles = await getAllServerProfiles(guildId);
  const matchMap = {};

  for (const direction of ['have', 'need']) {
    const opposite = direction === 'have' ? 'need' : 'have';
    for (const { userId: otherId, profileName: otherProfileName, profileData: otherProfile } of allServerProfiles) {
      if (otherId === userId && otherProfileName === profileName) continue;
      for (const album in albumsData) {
        if (!myProfile[direction]?.[album]) continue;
        for (const puzzle in albumsData[album]) {
          if (!myProfile[direction][album]?.[puzzle]) continue;
          const myPieces = myProfile[direction][album][puzzle].map(p => p.piece);
          const theirPieces = (otherProfile[opposite]?.[album]?.[puzzle] || []).map(p => p.piece);
          const matches = myPieces.filter(p => theirPieces.includes(p));
          if (matches.length > 0) {
            if (!matchMap[album]) matchMap[album] = {};
            if (!matchMap[album][puzzle]) matchMap[album][puzzle] = [];
            const verb = direction === 'have' ? 'needs it' : 'has it';
            matchMap[album][puzzle].push(`${matches.sort((a, b) => Number(a) - Number(b)).join(', ')} — <@${otherId}> [${otherProfileName}] ${verb}`);
          }
        }
      }
    }
  }

  if (Object.keys(matchMap).length === 0) return null;

  let body = `🔥 **Your current matches** [${profileName}]:\n\n`;
  for (const album in albumsData) {
    if (!matchMap[album]) continue;
    body += `**${dn(album)}:**\n`;
    for (const puzzle in albumsData[album]) {
      if (!matchMap[album]?.[puzzle]) continue;
      for (const line of matchMap[album][puzzle]) body += `${dn(puzzle)}: ${line}\n`;
    }
    body += '\n';
  }
  return body.trim();
}

async function createProfile(userId, profileName) {
  const now = Date.now();
  await profilesCollection.updateOne(
    { userId },
    {
      $set: {
        [`profiles.${profileName}.have`]: {},
        [`profiles.${profileName}.need`]: {},
        [`profiles.${profileName}.haveUpdated`]: now,
        [`profiles.${profileName}.needUpdated`]: now,
        [`profiles.${profileName}.lastReminder`]: 0,
      }
    },
    { upsert: true }
  );
}

async function getProfile(userId, profileName) {
  const doc = await getUserDoc(userId);
  return doc?.profiles?.[profileName] || null;
}

async function saveProfile(userId, profileName, profileData) {
  await profilesCollection.updateOne(
    { userId },
    { $set: { [`profiles.${profileName}`]: profileData } },
    { upsert: true }
  );
}

function makePieces(n) {
  return Array.from({ length: n }, (_, i) => (i + 1).toString());
}

// ======================
// HELPERS
// ======================
function formatList(typeData) {
  if (!typeData || Object.keys(typeData).length === 0) return null;
  let msg = '';
  for (const album in albumsData) {
    if (!typeData[album]) continue;
    msg += `**${dn(album)}:**\n`;
    for (const puzzle in albumsData[album]) {
      const pieces = (typeData[album][puzzle] || []).map(p => p.piece).sort((a, b) => Number(a) - Number(b));
      if (pieces.length > 0) msg += `${dn(puzzle)}: ${pieces.join(', ')}\n`;
    }
    msg += '\n';
  }
  return msg.trim() || null;
}

function getUserAlbums(profileData) {
  const albums = [];
  for (const album in albumsData) {
    const hasHave = Object.keys(profileData.have?.[album] || {}).some(p => (profileData.have[album][p] || []).length > 0);
    const hasNeed = Object.keys(profileData.need?.[album] || {}).some(p => (profileData.need[album][p] || []).length > 0);
    if (hasHave || hasNeed) albums.push(album);
  }
  return albums;
}

function getUserPuzzles(profileData, album) {
  const puzzles = [];
  for (const puzzle in albumsData[album]) {
    if ((profileData.have?.[album]?.[puzzle] || []).length > 0 || (profileData.need?.[album]?.[puzzle] || []).length > 0) {
      puzzles.push(puzzle);
    }
  }
  return puzzles;
}

function getUserPieces(profileData, album, puzzle) {
  const h = (profileData.have?.[album]?.[puzzle] || []).map(p => p.piece);
  const n = (profileData.need?.[album]?.[puzzle] || []).map(p => p.piece);
  return [...new Set([...h, ...n])].sort((a, b) => Number(a) - Number(b));
}

// Get all profile data for users in a server (for matching)
// Returns: [ { userId, profileName, profileData }, ... ]
async function getAllServerProfiles(guildId) {
  const link = await getServerLink(guildId);
  if (!link?.members) return [];
  const result = [];
  for (const [userId, memberData] of Object.entries(link.members)) {
    const userDoc = await getUserDoc(userId);
    if (!userDoc?.profiles) continue;
    for (const profileName of (memberData.linkedProfiles || [])) {
      const profileData = userDoc.profiles[profileName];
      if (profileData) result.push({ userId, profileName, profileData });
    }
  }
  return result;
}

function getMatchedAlbums(profileA, profileB) {
  const matched = [];
  for (const album in albumsData) {
    for (const puzzle in albumsData[album]) {
      const aHave = (profileA.have?.[album]?.[puzzle] || []).map(p => p.piece);
      const bNeed = (profileB.need?.[album]?.[puzzle] || []).map(p => p.piece);
      const bHave = (profileB.have?.[album]?.[puzzle] || []).map(p => p.piece);
      const aNeed = (profileA.need?.[album]?.[puzzle] || []).map(p => p.piece);
      if ((aHave.filter(p => bNeed.includes(p)).length > 0 || bHave.filter(p => aNeed.includes(p)).length > 0) && !matched.includes(album)) {
        matched.push(album);
      }
    }
  }
  return matched;
}

function getMatchedPuzzles(profileA, profileB, album) {
  const matched = [];
  for (const puzzle in albumsData[album]) {
    const aHave = (profileA.have?.[album]?.[puzzle] || []).map(p => p.piece);
    const bNeed = (profileB.need?.[album]?.[puzzle] || []).map(p => p.piece);
    const bHave = (profileB.have?.[album]?.[puzzle] || []).map(p => p.piece);
    const aNeed = (profileA.need?.[album]?.[puzzle] || []).map(p => p.piece);
    if (aHave.filter(p => bNeed.includes(p)).length > 0 || bHave.filter(p => aNeed.includes(p)).length > 0) {
      matched.push(puzzle);
    }
  }
  return matched;
}

function getMatchedPieces(profileA, profileB, album, puzzle) {
  const aHave = (profileA.have?.[album]?.[puzzle] || []).map(p => p.piece);
  const bNeed = (profileB.need?.[album]?.[puzzle] || []).map(p => p.piece);
  const bHave = (profileB.have?.[album]?.[puzzle] || []).map(p => p.piece);
  const aNeed = (profileA.need?.[album]?.[puzzle] || []).map(p => p.piece);
  return [...new Set([...aHave.filter(p => bNeed.includes(p)), ...bHave.filter(p => aNeed.includes(p))])].sort((a, b) => Number(a) - Number(b));
}

function cleanExpiredTrades() {
  const now = Date.now();
  for (const tradeId in pendingTrades) {
    if (pendingTrades[tradeId].expiresAt < now) delete pendingTrades[tradeId];
  }
}

// ======================
// REMINDERS
// ======================
async function sendReminders() {
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const allLinks = await serverLinksCollection.find({}).toArray();

  for (const link of allLinks) {
    const discordGuild = await client.guilds.fetch(link.guildId).catch(() => null);
    if (!discordGuild) continue;

    for (const [userId, memberData] of Object.entries(link.members || {})) {
      const userDoc = await getUserDoc(userId);
      if (!userDoc?.profiles) continue;

      for (const profileName of (memberData.linkedProfiles || [])) {
        const profile = userDoc.profiles[profileName];
        if (!profile) continue;
        const lastUpdated = Math.max(profile.haveUpdated || 0, profile.needUpdated || 0);
        if (lastUpdated === 0) continue;
        const daysSinceUpdate = (now - lastUpdated) / (24 * 60 * 60 * 1000);
        if (daysSinceUpdate < 7) continue;
        const daysSinceReminder = (now - (profile.lastReminder || 0)) / (24 * 60 * 60 * 1000);
        if (daysSinceReminder < 7) continue;

        try {
          const member = await discordGuild.members.fetch(userId).catch(() => null);
          if (!member) continue;
          await member.send(
            `👋 **Hey there!**\n\nIt's been a while since you last updated your **${profileName}** puzzle piece list on **${discordGuild.name}**!\n\nDon't forget — your data gets automatically deleted after **14 days** of inactivity. Head over to the server and use \`/have\` or \`/need\` to keep your list up to date so you don't miss any trades! 🧩\n\nSee you there! 😊`
          );
          profile.lastReminder = now;
          await saveProfile(userId, profileName, profile);
        } catch (_) {}
      }
    }
  }
}

// ======================
// CLEAN OLD DATA
// ======================
async function cleanOldData() {
  const now = Date.now();
  const timeout = 14 * 24 * 60 * 60 * 1000;
  const allUsers = await profilesCollection.find({}).toArray();

  for (const userDoc of allUsers) {
    if (!userDoc.profiles) continue;
    let changed = false;
    for (const [profileName, profile] of Object.entries(userDoc.profiles)) {
      if (profileName.startsWith('_')) continue;
      for (const type of ['have', 'need']) {
        const updated = profile[`${type}Updated`] || 0;
        if (now - updated > timeout) {
          profile[type] = {};
          changed = true;
        }
      }
      if (changed) await saveProfile(userDoc.userId, profileName, profile);
    }
  }
}

// ======================
// SAVE & REMOVE PIECES
// ======================
async function savePieces(userId, profileName, type, album, puzzle, pieces) {
  const profile = await getProfile(userId, profileName);
  if (!profile) return;
  const now = Date.now();
  if (!profile[type][album]) profile[type][album] = {};
  const existing = profile[type][album][puzzle] || [];
  const kept = existing.filter(p => !pieces.includes(p.piece));
  profile[type][album][puzzle] = [...kept, ...pieces.map(p => ({ piece: p, timestamp: now }))];
  profile[`${type}Updated`] = now;
  await saveProfile(userId, profileName, profile);
}

async function removePiecesFromProfile(userId, profileName, type, album, puzzle, pieces) {
  const profile = await getProfile(userId, profileName);
  if (!profile || !profile[type]?.[album]?.[puzzle]) return;
  profile[type][album][puzzle] = profile[type][album][puzzle].filter(p => !pieces.includes(p.piece));
  if (profile[type][album][puzzle].length === 0) delete profile[type][album][puzzle];
  await saveProfile(userId, profileName, profile);
}

// ======================
// CHECK MATCH
// ======================
async function checkMatch(guildId, userId, profileName, type, album, puzzle, channel) {
  const opposite = type === 'have' ? 'need' : 'have';
  const myProfile = await getProfile(userId, profileName);
  if (!myProfile) return;
  const myPieces = (myProfile[type]?.[album]?.[puzzle] || []).map(p => p.piece);
  const allProfiles = await getAllServerProfiles(guildId);

  for (const { userId: otherId, profileName: otherProfileName, profileData: otherProfile } of allProfiles) {
    if (otherId === userId && otherProfileName === profileName) continue;
    const otherPieces = (otherProfile[opposite]?.[album]?.[puzzle] || []).map(p => p.piece);
    const matches = myPieces.filter(p => otherPieces.includes(p));
    if (matches.length > 0 && channel) {
      await channel.send(
        `🔥 MATCH!\n<@${userId}> [${profileName}] (${type}) ↔ <@${otherId}> [${otherProfileName}] (${opposite})\nAlbum: ${dn(album)}\nPuzzle: ${dn(puzzle)}\nPieces: ${matches.join(', ')}`
      );
    }
  }
}

// ======================
// MENUS
// ======================
function albumMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('album').setPlaceholder('Select album')
      .addOptions(Object.keys(albumsData).map(a => ({ label: dn(a), value: a })))
  );
}

function removeAlbumMenu(albums) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('removeAlbum').setPlaceholder('Select album')
      .addOptions(albums.map(a => ({ label: dn(a), value: a })))
  );
}

function puzzleMenu(album) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`puzzle|${album}`).setPlaceholder('Select puzzle')
      .addOptions(Object.keys(albumsData[album]).map(p => ({ label: dn(p), value: p })))
  );
}

function removePuzzleMenu(puzzles, album) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`removePuzzle|${album}`).setPlaceholder('Select puzzle')
      .addOptions(puzzles.map(p => ({ label: dn(p), value: p })))
  );
}

function piecesMenu(album, puzzle) {
  const count = albumsData[album]?.[puzzle];
  if (!count) return null;
  const pieces = makePieces(count);
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`pieces|${album}|${puzzle}`).setPlaceholder('Select pieces')
      .setMinValues(1).setMaxValues(pieces.length).addOptions(pieces.map(p => ({ label: p, value: p })))
  );
}

function removePiecesMenu(pieces, album, puzzle) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`removePieces|${album}|${puzzle}`).setPlaceholder('Select pieces to remove')
      .setMinValues(1).setMaxValues(pieces.length).addOptions(pieces.map(p => ({ label: p, value: p })))
  );
}

function profileSelectMenu(profiles, customId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Select a profile')
      .addOptions(profiles.map(p => ({ label: p, value: p })))
  );
}

function listTypeMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('listType').setPlaceholder('Select list to view')
      .addOptions([{ label: 'Have', value: 'have' }, { label: 'Need', value: 'need' }])
  );
}

function matchesTypeMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('matchesType').setPlaceholder('Select match direction')
      .addOptions([
        { label: 'Pieces I have that others need', value: 'have' },
        { label: 'Pieces I need that others have', value: 'need' }
      ])
  );
}

function tradeUserMenu() {
  return new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId('tradeUser').setPlaceholder('Select the user you are trading with')
  );
}

function tradeAlbumMenu(matchedAlbums) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('tradeAlbum').setPlaceholder('Select album')
      .addOptions(matchedAlbums.map(a => ({ label: dn(a), value: a })))
  );
}

function tradePuzzleMenu(matchedPuzzles) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('tradePuzzle').setPlaceholder('Select puzzle')
      .addOptions(matchedPuzzles.map(p => ({ label: dn(p), value: p })))
  );
}

function tradePiecesMenu(matchedPieces) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('tradePieces').setPlaceholder('Select pieces to trade')
      .setMinValues(1).setMaxValues(matchedPieces.length).addOptions(matchedPieces.map(p => ({ label: p, value: p })))
  );
}

function tradeConfirmButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tradeConfirm|${tradeId}`).setLabel('✅ Confirm Trade').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tradeDecline|${tradeId}`).setLabel('❌ Decline Trade').setStyle(ButtonStyle.Danger)
  );
}

// Modal for profile name input
function profileNameModal(customId, title) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  const input = new TextInputBuilder().setCustomId('profileName').setLabel('Profile name (e.g. Main570, Farm600)')
    .setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(30).setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function profileRenameModal(oldName) {
  const modal = new ModalBuilder().setCustomId(`profileRenameModal|${oldName}`).setTitle(`Rename profile: ${oldName}`);
  const input = new TextInputBuilder().setCustomId('profileName').setLabel('New profile name')
    .setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(30).setRequired(true).setValue(oldName);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

// ======================
// ONBOARDING HELPER
// Returns the active profile for a user in a server, or triggers onboarding
// ======================
async function getActiveProfile(interaction, session) {
  const { guildId, user: { id: userId } } = interaction;
  const linkedProfiles = await getLinkedProfiles(guildId, userId);

  // No profiles at all — show create modal
  if (linkedProfiles.length === 0) {
    const userDoc = await getUserDoc(userId);
    const allProfiles = Object.keys(userDoc?.profiles || {}).filter(k => !k.startsWith('_'));

    if (allProfiles.length === 0) {
      // Brand new user — show create modal
      await interaction.showModal(profileNameModal('onboardCreate', '🧩 Create your first profile'));
      return null;
    } else {
      // Has profiles elsewhere — ask create or import
      await interaction.reply({
        content: `👋 Welcome! You have existing profiles. Would you like to **create a new profile** for this server or **import an existing one**?`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('onboardNew').setLabel('Create New Profile').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('onboardImport').setLabel('Import Existing Profile').setStyle(ButtonStyle.Secondary)
          )
        ],
        flags: 64
      });
      return null;
    }
  }

  // One profile — use it automatically
  if (linkedProfiles.length === 1) {
    session.activeProfile = linkedProfiles[0];
    await setLastUsedProfile(guildId, userId, linkedProfiles[0]);
    return linkedProfiles[0];
  }

  // Multiple profiles — check session memory first
  if (session.activeProfile && linkedProfiles.includes(session.activeProfile)) {
    return session.activeProfile;
  }

  // Check last used
  const lastUsed = await getLastUsedProfile(guildId, userId);
  if (lastUsed && linkedProfiles.includes(lastUsed)) {
    session.activeProfile = lastUsed;
    return lastUsed;
  }

  // Ask which profile to use
  await interaction.reply({
    content: `Which profile do you want to use?`,
    components: [profileSelectMenu(linkedProfiles, 'selectActiveProfile')],
    flags: 64
  });
  return null;
}

// ======================
// INTERACTIONS
// ======================
client.on('interactionCreate', async interaction => {
  if (!interaction.guildId) return;

  try {
    const { guildId, user: { id: userId } } = interaction;
    const session = getSession(guildId, userId);

    // ======================
    // MODALS
    // ======================
    if (interaction.isModalSubmit()) {
      const profileName = interaction.fields.getTextInputValue('profileName').trim();

      if (interaction.customId === 'onboardCreate') {
        await createProfile(userId, profileName);
        await linkProfileToServer(guildId, userId, profileName);
        session.activeProfile = profileName;

        // Continue with the pending command
        if (session.pendingCommand === 'have' || session.pendingCommand === 'need') {
          session.type = session.pendingCommand;
          return interaction.reply({ content: `✅ Profile **${profileName}** created!\n\nSelect album:`, components: [albumMenu()], flags: 64 });
        }
        return interaction.reply({ content: `✅ Profile **${profileName}** created and linked to this server!`, flags: 64 });
      }

      if (interaction.customId === 'profileCreateModal') {
        const userDoc = await getUserDoc(userId);
        if (userDoc?.profiles?.[profileName]) {
          return interaction.reply({ content: `❌ A profile named **${profileName}** already exists.`, flags: 64 });
        }
        await createProfile(userId, profileName);
        await linkProfileToServer(guildId, userId, profileName);
        session.activeProfile = profileName;
        return interaction.reply({ content: `✅ Profile **${profileName}** created and linked to this server!`, flags: 64 });
      }

      if (interaction.customId.startsWith('profileRenameModal|')) {
        const oldName = interaction.customId.split('|')[1];
        const newName = profileName;
        if (oldName === newName) return interaction.reply({ content: '❌ The new name is the same as the old name.', flags: 64 });
        const userDoc = await getUserDoc(userId);
        if (userDoc?.profiles?.[newName]) return interaction.reply({ content: `❌ A profile named **${newName}** already exists.`, flags: 64 });
        const success = await renameProfile(userId, oldName, newName);
        if (!success) return interaction.reply({ content: `❌ Profile **${oldName}** not found.`, flags: 64 });
        if (session.activeProfile === oldName) session.activeProfile = newName;
        return interaction.reply({ content: `✅ Profile renamed from **${oldName}** to **${newName}** across all servers!`, flags: 64 });
      }
    }

    // ======================
    // CHAT COMMANDS
    // ======================
    if (interaction.isChatInputCommand()) {

      if (interaction.commandName === 'have' || interaction.commandName === 'need') {
        session.pendingCommand = interaction.commandName;
        const profileName = await getActiveProfile(interaction, session);
        if (!profileName) return; // onboarding triggered
        session.type = interaction.commandName;
        return interaction.reply({ content: `📝 Using profile **${profileName}**\n\nSelect album:`, components: [albumMenu()], flags: 64 });
      }

      if (interaction.commandName === 'remove') {
        session.pendingCommand = 'remove';
        const profileName = await getActiveProfile(interaction, session);
        if (!profileName) return;
        const profile = await getProfile(userId, profileName);
        const albums = getUserAlbums(profile);
        if (albums.length === 0) return interaction.reply({ content: '❌ You have no data to remove.', flags: 64 });
        session.type = 'remove';
        return interaction.reply({ content: `📝 Using profile **${profileName}**\n\nSelect album:`, components: [removeAlbumMenu(albums)], flags: 64 });
      }

      if (interaction.commandName === 'list') {
        session.pendingCommand = 'list';
        const profileName = await getActiveProfile(interaction, session);
        if (!profileName) return;
        session.listProfile = profileName;
        return interaction.reply({ content: `📝 Using profile **${profileName}**\n\nWhich list do you want to see?`, components: [listTypeMenu()], flags: 64 });
      }

      if (interaction.commandName === 'matches') {
        session.pendingCommand = 'matches';
        const profileName = await getActiveProfile(interaction, session);
        if (!profileName) return;
        session.matchesProfile = profileName;
        return interaction.reply({ content: `📝 Using profile **${profileName}**\n\nWhich matches do you want to see?`, components: [matchesTypeMenu()], flags: 64 });
      }

      if (interaction.commandName === 'clear') {
        session.pendingCommand = 'clear';
        const profileName = await getActiveProfile(interaction, session);
        if (!profileName) return;
        session.clearProfile = profileName;
        return interaction.reply({
          content: `📝 Using profile **${profileName}**\n\nWhich list do you want to clear?`,
          components: [
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder().setCustomId('clearMenu').setPlaceholder('Select list to clear')
                .addOptions([{ label: 'Have', value: 'have' }, { label: 'Need', value: 'need' }, { label: 'Both', value: 'both' }])
            )
          ],
          flags: 64
        });
      }

      if (interaction.commandName === 'trade') {
        session.tradeStep = 'selectUser';
        return interaction.reply({ content: '🤝 Who are you trading with?', components: [tradeUserMenu()], flags: 64 });
      }

      // ======================
      // PROFILE COMMANDS
      // ======================
      if (interaction.commandName === 'profile') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'create') {
          await interaction.showModal(profileNameModal('profileCreateModal', '🧩 Create a new profile'));
          return;
        }

        if (sub === 'import') {
          const userDoc = await getUserDoc(userId);
          const allProfiles = Object.keys(userDoc?.profiles || {}).filter(k => !k.startsWith('_'));
          const linked = await getLinkedProfiles(guildId, userId);
          const importable = allProfiles.filter(p => !linked.includes(p));
          if (importable.length === 0) {
            return interaction.reply({ content: '❌ You have no profiles available to import. All your profiles are already linked to this server.', flags: 64 });
          }
          return interaction.reply({
            content: 'Which profile do you want to import to this server?',
            components: [profileSelectMenu(importable, 'importProfile')],
            flags: 64
          });
        }

        if (sub === 'list') {
          const userDoc = await getUserDoc(userId);
          const allProfiles = Object.keys(userDoc?.profiles || {}).filter(k => !k.startsWith('_'));
          if (allProfiles.length === 0) return interaction.reply({ content: '❌ You have no profiles yet.', flags: 64 });

          // Get all server links for this user
          const allLinks = await serverLinksCollection.find({ [`members.${userId}`]: { $exists: true } }).toArray();
          let msg = '📋 **Your Profiles:**\n\n';
          for (const profileName of allProfiles) {
            const servers = allLinks.filter(l => l.members?.[userId]?.linkedProfiles?.includes(profileName)).map(l => l.guildId);
            const serverNames = await Promise.all(servers.map(async gid => {
              const g = await client.guilds.fetch(gid).catch(() => null);
              return g ? g.name : gid;
            }));
            msg += `**${profileName}**${serverNames.length > 0 ? ` — linked to: ${serverNames.join(', ')}` : ' — not linked to any server'}\n`;
          }
          return interaction.reply({ content: msg, flags: 64 });
        }

        if (sub === 'unlink') {
          const linked = await getLinkedProfiles(guildId, userId);
          if (linked.length === 0) return interaction.reply({ content: '❌ You have no profiles linked to this server.', flags: 64 });
          return interaction.reply({
            content: 'Which profile do you want to unlink from this server?',
            components: [profileSelectMenu(linked, 'unlinkProfile')],
            flags: 64
          });
        }

        if (sub === 'rename') {
          const userDoc = await getUserDoc(userId);
          const allProfiles = Object.keys(userDoc?.profiles || {}).filter(k => !k.startsWith('_'));
          if (allProfiles.length === 0) return interaction.reply({ content: '❌ You have no profiles to rename.', flags: 64 });
          return interaction.reply({
            content: 'Which profile do you want to rename?',
            components: [profileSelectMenu(allProfiles, 'renameProfileSelect')],
            flags: 64
          });
        }

        if (sub === 'switch') {
          const linked = await getLinkedProfiles(guildId, userId);
          if (linked.length <= 1) return interaction.reply({ content: '❌ You only have one profile in this server.', flags: 64 });
          return interaction.reply({
            content: 'Which profile do you want to use for your next commands?',
            components: [profileSelectMenu(linked, 'switchProfile')],
            flags: 64
          });
        }

        if (sub === 'delete') {
          const userDoc = await getUserDoc(userId);
          const allProfiles = Object.keys(userDoc?.profiles || {}).filter(k => !k.startsWith('_'));
          if (allProfiles.length === 0) return interaction.reply({ content: '❌ You have no profiles to delete.', flags: 64 });
          return interaction.reply({
            content: '⚠️ Which profile do you want to **permanently delete**? This cannot be undone!',
            components: [profileSelectMenu(allProfiles, 'deleteProfile')],
            flags: 64
          });
        }
      }
    }

    // ======================
    // MENUS
    // ======================
    if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) {
      const parts = interaction.customId.split('|');

      // ONBOARDING — select active profile
      if (interaction.customId === 'selectActiveProfile') {
        const profileName = interaction.values[0];
        session.activeProfile = profileName;
        await setLastUsedProfile(guildId, userId, profileName);
        const pendingCmd = session.pendingCommand;
        if (pendingCmd === 'have' || pendingCmd === 'need') {
          session.type = pendingCmd;
          return interaction.update({ content: `📝 Using profile **${profileName}**\n\nSelect album:`, components: [albumMenu()] });
        }
        if (pendingCmd === 'remove') {
          const profile = await getProfile(userId, profileName);
          const albums = getUserAlbums(profile);
          if (albums.length === 0) return interaction.update({ content: '❌ You have no data to remove.', components: [] });
          session.type = 'remove';
          return interaction.update({ content: `📝 Using profile **${profileName}**\n\nSelect album:`, components: [removeAlbumMenu(albums)] });
        }
        if (pendingCmd === 'list') {
          session.listProfile = profileName;
          return interaction.update({ content: `📝 Using profile **${profileName}**\n\nWhich list do you want to see?`, components: [listTypeMenu()] });
        }
        if (pendingCmd === 'matches') {
          session.matchesProfile = profileName;
          return interaction.update({ content: `📝 Using profile **${profileName}**\n\nWhich matches do you want to see?`, components: [matchesTypeMenu()] });
        }
        if (pendingCmd === 'clear') {
          session.clearProfile = profileName;
          return interaction.update({
            content: `📝 Using profile **${profileName}**\n\nWhich list do you want to clear?`,
            components: [new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder().setCustomId('clearMenu').setPlaceholder('Select list to clear')
                .addOptions([{ label: 'Have', value: 'have' }, { label: 'Need', value: 'need' }, { label: 'Both', value: 'both' }])
            )]
          });
        }
        return interaction.update({ content: `✅ Now using profile **${profileName}**`, components: [] });
      }

      // UNLINK PROFILE
      if (interaction.customId === 'unlinkProfile') {
        const profileName = interaction.values[0];
        const link = await getServerLink(guildId);
        const updated = (link?.members?.[userId]?.linkedProfiles || []).filter(p => p !== profileName);
        await serverLinksCollection.updateOne(
          { guildId },
          { $set: { [`members.${userId}.linkedProfiles`]: updated } }
        );
        if (session.activeProfile === profileName) delete session.activeProfile;
        return interaction.update({ content: `✅ Profile **${profileName}** has been unlinked from this server. Your profile data is safe and still available in other servers.`, components: [] });
      }

      // RENAME PROFILE SELECT
      if (interaction.customId === 'renameProfileSelect') {
        const profileName = interaction.values[0];
        await interaction.showModal(profileRenameModal(profileName));
        return;
      }

      // SWITCH PROFILE
      if (interaction.customId === 'switchProfile') {
        const profileName = interaction.values[0];
        session.activeProfile = profileName;
        await setLastUsedProfile(guildId, userId, profileName);
        return interaction.update({ content: `✅ Switched to profile **${profileName}**. Your next commands will use this profile.`, components: [] });
      }

      // IMPORT PROFILE
      if (interaction.customId === 'importProfile') {
        const profileName = interaction.values[0];
        await linkProfileToServer(guildId, userId, profileName);
        session.activeProfile = profileName;

        // Show instant matches
        const matchBody = await getInstantMatches(guildId, userId, profileName);
        if (matchBody) {
          const chunks = [];
          let current = `✅ Profile **${profileName}** has been linked to this server!\n\n`;
          for (const line of matchBody.split('\n')) {
            if (current.length + line.length + 1 > 1900) { chunks.push(current); current = ''; }
            current += line + '\n';
          }
          if (current.trim()) chunks.push(current);
          await interaction.update({ content: chunks[0], components: [] });
          for (let i = 1; i < chunks.length; i++) await interaction.followUp({ content: chunks[i], flags: 64 });
        } else {
          return interaction.update({ content: `✅ Profile **${profileName}** has been linked to this server!\n\nNo matches found yet — use \`/have\` and \`/need\` to register your pieces.`, components: [] });
        }
        return;
      }

      // DELETE PROFILE
      if (interaction.customId === 'deleteProfile') {
        const profileName = interaction.values[0];
        await profilesCollection.updateOne({ userId }, { $unset: { [`profiles.${profileName}`]: '' } });
        // Remove from all server links
        const allLinks = await serverLinksCollection.find({ [`members.${userId}.linkedProfiles`]: profileName }).toArray();
        for (const link of allLinks) {
          const updated = link.members[userId].linkedProfiles.filter(p => p !== profileName);
          await serverLinksCollection.updateOne(
            { guildId: link.guildId },
            { $set: { [`members.${userId}.linkedProfiles`]: updated } }
          );
        }
        if (session.activeProfile === profileName) delete session.activeProfile;
        return interaction.update({ content: `✅ Profile **${profileName}** has been permanently deleted.`, components: [] });
      }

      // REMOVE ALBUM
      if (interaction.customId === 'removeAlbum') {
        const album = interaction.values[0];
        const profileName = session.activeProfile;
        const profile = await getProfile(userId, profileName);
        const puzzles = getUserPuzzles(profile, album);
        if (puzzles.length === 0) return interaction.update({ content: '❌ No data in this album.', components: [] });
        session.removeAlbum = album;
        return interaction.update({ content: `Album: **${dn(album)}**\nSelect a puzzle:`, components: [removePuzzleMenu(puzzles, album)] });
      }

      if (parts[0] === 'removePuzzle') {
        const album = parts[1];
        const puzzle = interaction.values[0];
        const profileName = session.activeProfile;
        const profile = await getProfile(userId, profileName);
        const pieces = getUserPieces(profile, album, puzzle);
        if (pieces.length === 0) return interaction.update({ content: '❌ No pieces in this puzzle.', components: [] });
        session.removeAlbum = album;
        session.removePuzzle = puzzle;
        return interaction.update({ content: `Album: **${dn(album)}** | Puzzle: **${dn(puzzle)}**\nSelect pieces to remove:`, components: [removePiecesMenu(pieces, album, puzzle)] });
      }

      if (parts[0] === 'removePieces') {
        const album = parts[1];
        const puzzle = parts[2];
        const pieces = interaction.values;
        const profileName = session.activeProfile;
        await interaction.deferUpdate();
        await removePiecesFromProfile(userId, profileName, 'have', album, puzzle, pieces);
        await removePiecesFromProfile(userId, profileName, 'need', album, puzzle, pieces);
        return interaction.editReply({ content: `✅ Removed pieces **${pieces.join(', ')}** from **${dn(puzzle)}**`, components: [] });
      }

      // TRADE USER
      if (interaction.customId === 'tradeUser') {
        const userBId = interaction.values[0];
        if (userBId === userId) return interaction.update({ content: '❌ You cannot trade with yourself!', components: [] });

        const myProfileName = session.activeProfile || await getLastUsedProfile(guildId, userId);
        if (!myProfileName) return interaction.update({ content: '❌ You have no active profile.', components: [] });
        const myProfile = await getProfile(userId, myProfileName);
        if (!myProfile) return interaction.update({ content: '❌ You have no data registered.', components: [] });

        // Get all profiles of userB in this server
        const userBProfiles = await getLinkedProfiles(guildId, userBId);
        if (userBProfiles.length === 0) return interaction.update({ content: '❌ That user has no data registered in this server.', components: [] });

        // Find all matches across all their profiles
        let allMatchedAlbums = [];
        for (const bProfileName of userBProfiles) {
          const bProfile = await getProfile(userBId, bProfileName);
          if (!bProfile) continue;
          const albums = getMatchedAlbums(myProfile, bProfile);
          allMatchedAlbums = [...new Set([...allMatchedAlbums, ...albums])];
        }

        if (allMatchedAlbums.length === 0) return interaction.update({ content: `❌ You have no matches with <@${userBId}>.`, components: [] });

        session.tradeUserB = userBId;
        session.tradeMyProfile = myProfileName;
        session.tradeStep = 'selectAlbum';
        return interaction.update({ content: `Trading with <@${userBId}>. Select an album:`, components: [tradeAlbumMenu(allMatchedAlbums)] });
      }

      if (interaction.customId === 'tradeAlbum') {
        const album = interaction.values[0];
        const myProfile = await getProfile(userId, session.tradeMyProfile);
        const userBProfiles = await getLinkedProfiles(guildId, session.tradeUserB);
        let allMatchedPuzzles = [];
        for (const bProfileName of userBProfiles) {
          const bProfile = await getProfile(session.tradeUserB, bProfileName);
          if (!bProfile) continue;
          const puzzles = getMatchedPuzzles(myProfile, bProfile, album);
          allMatchedPuzzles = [...new Set([...allMatchedPuzzles, ...puzzles])];
        }
        if (allMatchedPuzzles.length === 0) return interaction.update({ content: '❌ No matched puzzles in this album.', components: [] });
        session.tradeAlbum = album;
        return interaction.update({ content: `Album: **${dn(album)}**\nSelect a puzzle:`, components: [tradePuzzleMenu(allMatchedPuzzles)] });
      }

      if (interaction.customId === 'tradePuzzle') {
        const puzzle = interaction.values[0];
        const myProfile = await getProfile(userId, session.tradeMyProfile);
        const userBProfiles = await getLinkedProfiles(guildId, session.tradeUserB);
        let allMatchedPieces = [];
        session.tradeBProfileMap = {};
        for (const bProfileName of userBProfiles) {
          const bProfile = await getProfile(session.tradeUserB, bProfileName);
          if (!bProfile) continue;
          const pieces = getMatchedPieces(myProfile, bProfile, session.tradeAlbum, puzzle);
          for (const p of pieces) {
            if (!allMatchedPieces.includes(p)) {
              allMatchedPieces.push(p);
              session.tradeBProfileMap[p] = bProfileName;
            }
          }
        }
        allMatchedPieces.sort((a, b) => Number(a) - Number(b));
        if (allMatchedPieces.length === 0) return interaction.update({ content: '❌ No matched pieces in this puzzle.', components: [] });
        session.tradePuzzle = puzzle;
        return interaction.update({ content: `Album: **${dn(session.tradeAlbum)}** | Puzzle: **${dn(puzzle)}**\nSelect the pieces you are trading:`, components: [tradePiecesMenu(allMatchedPieces)] });
      }

      if (interaction.customId === 'tradePieces') {
        const pieces = interaction.values;
        const tradeId = `${userId}_${session.tradeUserB}_${Date.now()}`;
        const expiresAt = Date.now() + 15 * 60 * 1000;
        pendingTrades[tradeId] = {
          guildId,
          userA: userId,
          userAProfile: session.tradeMyProfile,
          userB: session.tradeUserB,
          userBProfileMap: session.tradeBProfileMap,
          album: session.tradeAlbum,
          puzzle: session.tradePuzzle,
          pieces,
          expiresAt
        };
        await interaction.update({
          content: `⏳ Trade request sent to <@${session.tradeUserB}>!\nWaiting for their confirmation *(15 minutes)*.\n\n**${dn(session.tradeAlbum)} → ${dn(session.tradePuzzle)}**\nPieces: ${pieces.join(', ')}`,
          components: []
        });
        await interaction.channel.send({
          content: `🤝 <@${session.tradeUserB}>, <@${userId}> wants to trade with you!\n\n**${dn(session.tradeAlbum)} → ${dn(session.tradePuzzle)}**\nPieces: ${pieces.join(', ')}\n\nDo you confirm this trade? *(expires in 15 minutes)*`,
          components: [tradeConfirmButtons(tradeId)]
        });
        return;
      }

      // LIST TYPE
      if (interaction.customId === 'listType') {
        const type = interaction.values[0];
        const profileName = session.listProfile || session.activeProfile;
        const profile = await getProfile(userId, profileName);
        const formatted = formatList(profile?.[type]);
        if (!formatted) return interaction.update({ content: `Your **${type}** list is empty.`, components: [] });
        const chunks = [];
        let current = `📋 **Your ${type.toUpperCase()} list** [${profileName}]:\n\n`;
        for (const line of formatted.split('\n')) {
          if (current.length + line.length + 1 > 1900) { chunks.push(current); current = ''; }
          current += line + '\n';
        }
        if (current.trim()) chunks.push(current);
        await interaction.update({ content: chunks[0], components: [] });
        for (let i = 1; i < chunks.length; i++) await interaction.followUp({ content: chunks[i], flags: 64 });
        return;
      }

      // MATCHES TYPE
      if (interaction.customId === 'matchesType') {
        const direction = interaction.values[0];
        const opposite = direction === 'have' ? 'need' : 'have';
        const myProfileName = session.matchesProfile || session.activeProfile;
        const myProfile = await getProfile(userId, myProfileName);
        if (!myProfile) return interaction.update({ content: 'You have no data.', components: [] });

        const allServerProfiles = await getAllServerProfiles(guildId);
        const matchMap = {};

        for (const { userId: otherId, profileName: otherProfileName, profileData: otherProfile } of allServerProfiles) {
          if (otherId === userId && otherProfileName === myProfileName) continue;
          for (const album in albumsData) {
            if (!myProfile[direction]?.[album]) continue;
            for (const puzzle in albumsData[album]) {
              if (!myProfile[direction][album]?.[puzzle]) continue;
              const myPieces = myProfile[direction][album][puzzle].map(p => p.piece);
              const theirPieces = (otherProfile[opposite]?.[album]?.[puzzle] || []).map(p => p.piece);
              const matches = myPieces.filter(p => theirPieces.includes(p));
              if (matches.length > 0) {
                if (!matchMap[album]) matchMap[album] = {};
                if (!matchMap[album][puzzle]) matchMap[album][puzzle] = [];
                const verb = direction === 'have' ? 'needs it' : 'has it';
                matchMap[album][puzzle].push(`${matches.sort((a, b) => Number(a) - Number(b)).join(', ')} — <@${otherId}> [${otherProfileName}] ${verb}`);
              }
            }
          }
        }

        if (Object.keys(matchMap).length === 0) return interaction.update({ content: 'No current matches found.', components: [] });

        const label = direction === 'have' ? 'Pieces I HAVE that others need' : 'Pieces I NEED that others have';
        let body = `🔥 **${label}** [${myProfileName}]:\n\n`;
        for (const album in albumsData) {
          if (!matchMap[album]) continue;
          body += `**${dn(album)}:**\n`;
          for (const puzzle in albumsData[album]) {
            if (!matchMap[album]?.[puzzle]) continue;
            for (const line of matchMap[album][puzzle]) body += `${dn(puzzle)}: ${line}\n`;
          }
          body += '\n';
        }

        const chunks = [];
        let current = '';
        for (const line of body.split('\n')) {
          if (current.length + line.length + 1 > 1900) { chunks.push(current); current = ''; }
          current += line + '\n';
        }
        if (current.trim()) chunks.push(current);
        await interaction.update({ content: chunks[0], components: [] });
        for (let i = 1; i < chunks.length; i++) await interaction.followUp({ content: chunks[i], flags: 64 });
        return;
      }

      // CLEAR MENU
      if (interaction.customId === 'clearMenu') {
        const choice = interaction.values[0];
        const profileName = session.clearProfile || session.activeProfile;
        const profile = await getProfile(userId, profileName);
        if (!profile) return interaction.update({ content: 'No data to clear.', components: [] });
        if (choice === 'have' || choice === 'both') profile.have = {};
        if (choice === 'need' || choice === 'both') profile.need = {};
        await saveProfile(userId, profileName, profile);
        return interaction.update({ content: `✅ Cleared **${choice}** for profile **${profileName}**`, components: [] });
      }

      // ALBUM MENU
      if (interaction.customId === 'album') {
        session.album = interaction.values[0];
        return interaction.update({ content: `Album: **${dn(session.album)}**`, components: [puzzleMenu(session.album)] });
      }

      // PUZZLE MENU
      if (parts[0] === 'puzzle') {
        session.album = parts[1];
        session.puzzle = interaction.values[0];
        return interaction.update({ content: `Puzzle: **${dn(session.puzzle)}**`, components: [piecesMenu(parts[1], session.puzzle)] });
      }

      // PIECES MENU
      if (parts[0] === 'pieces') {
        const album = parts[1];
        const puzzle = parts[2];
        const pieces = interaction.values;
        const profileName = session.activeProfile;
        await interaction.deferUpdate();
        await savePieces(userId, profileName, session.type, album, puzzle, pieces);
        if (interaction.channel) {
          await interaction.channel.send(`📦 <@${userId}> [${profileName}] updated their ${session.type} list for ${dn(puzzle)}: ${pieces.join(', ')}`);
        }
        await checkMatch(guildId, userId, profileName, session.type, album, puzzle, interaction.channel);
        return interaction.editReply({ content: `✅ Updated **${dn(puzzle)}**`, components: [] });
      }
    }

    // ======================
    // BUTTONS
    // ======================
    if (interaction.isButton()) {
      const parts = interaction.customId.split('|');

      // ONBOARD NEW
      if (interaction.customId === 'onboardNew') {
        await interaction.showModal(profileNameModal('onboardCreate', '🧩 Create your profile'));
        return;
      }

      // ONBOARD IMPORT
      if (interaction.customId === 'onboardImport') {
        const userDoc = await getUserDoc(userId);
        const allProfiles = Object.keys(userDoc?.profiles || {}).filter(k => !k.startsWith('_'));
        return interaction.update({
          content: 'Which profile do you want to import?',
          components: [profileSelectMenu(allProfiles, 'importProfile')]
        });
      }

      // TRADE BUTTONS
      if (parts[0] === 'tradeConfirm' || parts[0] === 'tradeDecline') {
        const tradeId = parts[1];
        cleanExpiredTrades();
        const trade = pendingTrades[tradeId];
        if (!trade) return interaction.reply({ content: '❌ This trade has expired or no longer exists.', flags: 64 });
        if (interaction.user.id !== trade.userB) return interaction.reply({ content: '❌ This trade request is not for you.', flags: 64 });

        if (parts[0] === 'tradeDecline') {
          delete pendingTrades[tradeId];
          await interaction.update({ content: `❌ <@${trade.userB}> declined the trade with <@${trade.userA}>.\n\n**${dn(trade.album)} → ${dn(trade.puzzle)}**\nPieces: ${trade.pieces.join(', ')}`, components: [] });
          await interaction.channel.send(`<@${trade.userA}> your trade request was declined by <@${trade.userB}>. ❌`);
          return;
        }

        if (parts[0] === 'tradeConfirm') {
          const { guildId: tGuildId, userA, userAProfile, userB, userBProfileMap, album, puzzle, pieces } = trade;
          delete pendingTrades[tradeId];
          // Remove from userA's profile
          await removePiecesFromProfile(userA, userAProfile, 'have', album, puzzle, pieces);
          await removePiecesFromProfile(userA, userAProfile, 'need', album, puzzle, pieces);
          // Remove from userB's profiles (each piece mapped to its profile)
          const bPiecesByProfile = {};
          for (const piece of pieces) {
            const bProfile = userBProfileMap[piece] || (await getLinkedProfiles(tGuildId, userB))[0];
            if (!bPiecesByProfile[bProfile]) bPiecesByProfile[bProfile] = [];
            bPiecesByProfile[bProfile].push(piece);
          }
          for (const [bProfileName, bPieces] of Object.entries(bPiecesByProfile)) {
            await removePiecesFromProfile(userB, bProfileName, 'have', album, puzzle, bPieces);
            await removePiecesFromProfile(userB, bProfileName, 'need', album, puzzle, bPieces);
          }
          await interaction.update({ content: `✅ Trade confirmed between <@${userA}> and <@${userB}>!\n\n**${dn(album)} → ${dn(puzzle)}**\nPieces traded: ${pieces.join(', ')}`, components: [] });
          await interaction.channel.send(`🎉 <@${userA}> <@${userB}> your trade is complete! Pieces **${pieces.join(', ')}** from **${dn(puzzle)}** have been removed from both your lists.`);
          return;
        }
      }
    }

  } catch (err) {
    console.error("❌ Erro na interação:", err);
    try {
      if (interaction.replied || interaction.deferred) return;
      await interaction.reply({ content: '❌ Algo deu errado. Tente novamente.', flags: 64 });
    } catch (_) {}
  }
});

// ======================
// AUTO-UNLINK ON LEAVE
// ======================
client.on('guildMemberRemove', async member => {
  const { guild, id: userId } = member;
  try {
    const link = await serverLinksCollection.findOne({ guildId: guild.id });
    if (!link?.members?.[userId]) return;
    await serverLinksCollection.updateOne(
      { guildId: guild.id },
      { $unset: { [`members.${userId}`]: '' } }
    );
    console.log(`🚪 Unlinked profiles for user ${userId} from guild ${guild.id} (left server)`);
  } catch (err) {
    console.error('❌ Error on guildMemberRemove:', err);
  }
});

// ======================
// START
// ======================
async function start() {
  await connectDB();
  await runMigrations();
  await client.login(process.env.TOKEN);
}

client.once('clientReady', async () => {
  await client.application.commands.set([
    { name: 'have', description: 'Pieces you have' },
    { name: 'need', description: 'Pieces you need' },
    { name: 'remove', description: 'Remove pieces from your lists' },
    { name: 'list', description: 'See your pieces' },
    { name: 'clear', description: 'Clear your data' },
    { name: 'matches', description: 'See your current matches' },
    { name: 'trade', description: 'Trade pieces with another user' },
    {
      name: 'profile',
      description: 'Manage your puzzle profiles',
      options: [
        { name: 'create', type: 1, description: 'Create a new profile' },
        { name: 'import', type: 1, description: 'Import an existing profile to this server' },
        { name: 'list', type: 1, description: 'See all your profiles' },
        { name: 'switch', type: 1, description: 'Switch active profile for this session' },
        { name: 'rename', type: 1, description: 'Rename a profile' },
        { name: 'unlink', type: 1, description: 'Unlink a profile from this server' },
        { name: 'delete', type: 1, description: 'Delete a profile permanently' }
      ]
    }
  ]);

  setInterval(cleanOldData, 60 * 60 * 1000);
  setInterval(sendReminders, 60 * 60 * 1000);
  console.log(`✅ Logged in as ${client.user.tag}`);
});

start();
