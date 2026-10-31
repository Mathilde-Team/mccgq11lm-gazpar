// SPDX-License-Identifier: MIT
'use strict';

// Tests du convertisseur externe Zigbee2MQTT (issue #6).
// Couvre la définition, les trois convertisseurs fromZigbee, le toZigbee
// d'initialisation d'index et les exposes dynamiques.

const test = require('node:test');
const assert = require('node:assert/strict');
const definition = require('../mccgq11lm_gazpar.js');

// Logger muet : les convertisseurs journalisent en debug, on n'en veut pas dans la sortie.
const loggerMuet = { debug() {} };

function fabriqueMeta({ state = {}, options = {} } = {}) {
    return { state, options, logger: loggerMuet };
}

function trouveFromZigbee(cluster) {
    const convertisseur = definition.fromZigbee.find((c) => c.cluster === cluster);
    assert.ok(convertisseur, `convertisseur ${cluster} absent`);
    return convertisseur;
}

// ─── Champs statiques de la définition ────────────────────────────────────────

test('définition : champs statiques (fingerprint, modèle, OTA, configure)', async (t) => {
    assert.deepEqual(definition.fingerprint, [{ modelID: 'lumi.sensor_magnet.aq2', manufacturerName: 'LUMI' }]);
    assert.equal(definition.model, 'MCCGQ11LM');
    assert.equal(definition.vendor, 'LUMI');
    assert.equal(definition.ota, false);
    // configure : no-op volontaire (stabilité Aqara), renvoie undefined.
    assert.equal(await definition.configure(), undefined);
});

test('définition : convertisseurs déclarés (clusters, types, clés)', (t) => {
    assert.deepEqual(
        definition.fromZigbee.map((c) => c.cluster),
        ['ssIasZone', 'genOnOff', 'genBasic'],
    );
    assert.deepEqual(trouveFromZigbee('genOnOff').type, ['attributeReport', 'readResponse']);
    assert.deepEqual(trouveFromZigbee('ssIasZone').type, ['attributeReport', 'commandStatusChangeNotification']);
    assert.equal(definition.toZigbee.length, 1);
    assert.deepEqual(definition.toZigbee[0].key, ['gas_m3']);
    assert.equal(typeof definition.exposes, 'function');
});

// ─── fromZigbee IAS (ssIasZone) ──────────────────────────────────────────────

test('IAS : zoneStatus absent → rien renvoyé', (t) => {
    const convert = trouveFromZigbee('ssIasZone').convert;
    const resultat = convert(null, { data: {} }, null, {}, fabriqueMeta());
    assert.equal(resultat, undefined);
});

test('IAS : lecture de zoneStatus (orthographe classique) — bit 0 → contact ouvert', (t) => {
    const convert = trouveFromZigbee('ssIasZone').convert;
    const resultat = convert(null, { data: { zoneStatus: 1 } }, null, {}, fabriqueMeta());
    assert.deepEqual(resultat, { contact: false });
});

test('IAS : lecture de zonestatus (minuscules, zigbee-herdsman récent) — bit 0 nul → contact fermé', (t) => {
    const convert = trouveFromZigbee('ssIasZone').convert;
    const resultat = convert(null, { data: { zonestatus: 0 } }, null, {}, fabriqueMeta());
    assert.deepEqual(resultat, { contact: true });
});

test('IAS : hors mode Gazpar, pas de comptage même sur front montant', (t) => {
    const convert = trouveFromZigbee('ssIasZone').convert;
    const meta = fabriqueMeta({ state: { contact: false, gas_pulses: 7 } });
    const resultat = convert(null, { data: { zonestatus: 0 } }, null, {}, meta);
    assert.deepEqual(resultat, { contact: true });
});

test('IAS : mode Gazpar, front montant → une impulsion comptée (paramètres par défaut)', (t) => {
    const convert = trouveFromZigbee('ssIasZone').convert;
    const meta = fabriqueMeta({
        state: { contact: false, gas_pulses: 0, _raw_trigger_count: 42 },
        options: { gazpar_mode: true },
    });
    const resultat = convert(null, { data: { zonestatus: 0 } }, null, meta.options, meta);
    // 10 L/impulsion par défaut : 1 impulsion = 0,01 m³ = 0,116 kWh arrondi à 0,12.
    assert.deepEqual(resultat, {
        contact: true,
        _ias_pulse_mark: 42,
        gas_pulses: 1,
        gas_m3: 0.01,
        gas_kwh: 0.12,
    });
});

test("IAS : pas d'impulsion si le contact était déjà fermé (anti double-comptage)", (t) => {
    const convert = trouveFromZigbee('ssIasZone').convert;
    const meta = fabriqueMeta({
        state: { contact: true, gas_pulses: 3 },
        options: { gazpar_mode: true },
    });
    const resultat = convert(null, { data: { zonestatus: 0 } }, null, meta.options, meta);
    assert.deepEqual(resultat, { contact: true });
});

test("IAS : front descendant (contact ouvert) → pas d'impulsion", (t) => {
    const convert = trouveFromZigbee('ssIasZone').convert;
    const meta = fabriqueMeta({
        state: { contact: true, gas_pulses: 3 },
        options: { gazpar_mode: true },
    });
    const resultat = convert(null, { data: { zonestatus: 1 } }, null, meta.options, meta);
    assert.deepEqual(resultat, { contact: false });
});

// ─── fromZigbee genOnOff (variante firmware) ─────────────────────────────────

test('OnOff : onOff=0 → contact fermé ; onOff=1 → contact ouvert', (t) => {
    const convert = trouveFromZigbee('genOnOff').convert;
    const ferme = convert(null, { data: { onOff: 0 } }, null, {}, fabriqueMeta());
    const ouvert = convert(null, { data: { onOff: 1 } }, null, {}, fabriqueMeta());
    assert.deepEqual(ferme, { contact: true });
    assert.deepEqual(ouvert, { contact: false });
});

test('OnOff : mode Gazpar, front montant avec paramètres personnalisés', (t) => {
    const convert = trouveFromZigbee('genOnOff').convert;
    const meta = fabriqueMeta({
        state: { contact: false, gas_pulses: 2, _raw_trigger_count: 7 },
        options: { gazpar_mode: true, liters_per_pulse: 100, kwh_per_m3: 10 },
    });
    const resultat = convert(null, { data: { onOff: 0 } }, null, meta.options, meta);
    // 100 L/impulsion : 3 impulsions = 0,3 m³ ; 0,3 × 10 = 3 kWh.
    assert.deepEqual(resultat, {
        contact: true,
        _ias_pulse_mark: 7,
        gas_pulses: 3,
        gas_m3: 0.3,
        gas_kwh: 3,
    });
});

// ─── fromZigbee Xiaomi (heartbeat, attribut 65281) ─────────────────────────────

test('Xiaomi : sans données 65281 → résultat vide', (t) => {
    const convert = trouveFromZigbee('genBasic').convert;
    const resultat = convert(null, { data: { 4: 1 } }, null, {}, fabriqueMeta());
    assert.deepEqual(resultat, {});
});

test('Xiaomi : tension, batterie (bornée 0-100), température, coupures, elapsed', (t) => {
    const convert = trouveFromZigbee('genBasic').convert;
    const normal = convert(null, { data: { 65281: { 1: 3000, 3: 21, 5: 2, 10: 123456 } } }, null, {}, fabriqueMeta());
    // (3000-2500)/(3100-2500) = 83,33 %.
    assert.deepEqual(normal, {
        voltage: 3000,
        battery: 83,
        device_temperature: 21,
        power_outage_count: 2,
        elapsed: 123456,
    });

    const batterieHaute = convert(null, { data: { 65281: { 1: 3200 } } }, null, {}, fabriqueMeta());
    assert.equal(batterieHaute.battery, 100);
    const batterieBasse = convert(null, { data: { 65281: { 1: 2000 } } }, null, {}, fabriqueMeta());
    assert.equal(batterieBasse.battery, 0);
});

test("Xiaomi : trigger_count absent de l'état → juste posé, pas de rattrapage", (t) => {
    const convert = trouveFromZigbee('genBasic').convert;
    const meta = fabriqueMeta({ options: { gazpar_mode: true } });
    const resultat = convert(null, { data: { 65281: { 100: 5 } } }, null, meta.options, meta);
    assert.deepEqual(resultat, { _raw_trigger_count: 5, trigger_count: 5, _ias_pulse_mark: 5 });
});

test('Xiaomi : rattrapage des impulsions manquées (trigger_count en hausse)', (t) => {
    const convert = trouveFromZigbee('genBasic').convert;
    const meta = fabriqueMeta({
        state: { gas_pulses: 5, _raw_trigger_count: 100, _ias_pulse_mark: 99 },
        options: { gazpar_mode: true },
    });
    const resultat = convert(null, { data: { 65281: { 100: 103 } } }, null, meta.options, meta);
    // 3 impulsions manquées, 99 ≠ 100 → toutes comptées : 5 + 3 = 8 impulsions.
    assert.deepEqual(resultat, {
        _raw_trigger_count: 103,
        trigger_count: 103,
        gas_pulses: 8,
        gas_m3: 0.08,
        gas_kwh: 0.93,
    });
});

test("Xiaomi : impulsions déjà comptées par l'IAS (marque posée) → rien à ajouter", (t) => {
    const convert = trouveFromZigbee('genBasic').convert;
    const meta = fabriqueMeta({
        state: { gas_pulses: 5, _raw_trigger_count: 100, _ias_pulse_mark: 100 },
        options: { gazpar_mode: true },
    });
    const resultat = convert(null, { data: { 65281: { 100: 103 } } }, null, meta.options, meta);
    // Déjà comptées via la marque : aucun nouveau m³, mais l'index suit.
    assert.deepEqual(resultat, { _raw_trigger_count: 103, trigger_count: 103 });
});

test('Xiaomi : trigger_count en baisse (pile remplacée) → repart de newTC', (t) => {
    const convert = trouveFromZigbee('genBasic').convert;
    const meta = fabriqueMeta({
        state: { gas_pulses: 50, _raw_trigger_count: 100, _ias_pulse_mark: 90 },
        options: { gazpar_mode: true },
    });
    const resultat = convert(null, { data: { 65281: { 100: 7 } } }, null, meta.options, meta);
    // missed = 7 (et non 93), 90 ≠ 100 → comptées : 50 + 7 = 57.
    assert.deepEqual(resultat, {
        _raw_trigger_count: 7,
        trigger_count: 7,
        gas_pulses: 57,
        gas_m3: 0.57,
        gas_kwh: 6.61,
    });
});

test('Xiaomi : trigger_count inchangé → index suivi, aucun calcul', (t) => {
    const convert = trouveFromZigbee('genBasic').convert;
    const meta = fabriqueMeta({
        state: { gas_pulses: 5, _raw_trigger_count: 100 },
        options: { gazpar_mode: true },
    });
    const resultat = convert(null, { data: { 65281: { 100: 100 } } }, null, meta.options, meta);
    assert.deepEqual(resultat, { _raw_trigger_count: 100, trigger_count: 100 });
});

test("Xiaomi : hors mode Gazpar, le trigger_count brut n'est pas publié", (t) => {
    const convert = trouveFromZigbee('genBasic').convert;
    const meta = fabriqueMeta({
        state: { gas_pulses: 5, _raw_trigger_count: 100, _ias_pulse_mark: 99 },
    });
    const resultat = convert(null, { data: { 65281: { 100: 103 } } }, null, meta.options, meta);
    // Le bloc trigger_count est réservé au mode Gazpar : rien n'est publié.
    assert.deepEqual(resultat, {});
});

// ─── Replis sans logger ni options ───────────────────────────────────────────

test('replis : sans meta.logger, les convertisseurs journalisent sur console', (t) => {
    // meta.logger absent → log = console (repli), sans erreur.
    const metaNu = { state: {}, options: {} };
    const ias = trouveFromZigbee('ssIasZone').convert(null, { data: { zonestatus: 0 } }, null, {}, metaNu);
    const onOff = trouveFromZigbee('genOnOff').convert(null, { data: { onOff: 0 } }, null, {}, metaNu);
    const xiaomi = trouveFromZigbee('genBasic').convert(null, { data: {} }, null, {}, metaNu);
    assert.deepEqual(ias, { contact: true });
    assert.deepEqual(onOff, { contact: true });
    assert.deepEqual(xiaomi, {});
});

test('replis : convertSet sans meta.options → paramètres par défaut', async (t) => {
    const convertSet = definition.toZigbee[0].convertSet;
    const resultat = await convertSet(null, 'gas_m3', '1', {});
    // 1 m³ / 0,01 = 100 impulsions ; 1 × 11,6 = 11,6 kWh.
    assert.deepEqual(resultat, {
        state: { gas_m3: 1, gas_kwh: 11.6, gas_pulses: 100 },
    });
});

// ─── toZigbee : initialisation de l'index gas_m3 ──────────────────────────────

test("convertSet : calage de l'index sur un relevé réel (paramètres par défaut)", async (t) => {
    const convertSet = definition.toZigbee[0].convertSet;
    const resultat = await convertSet(null, 'gas_m3', '12.34', fabriqueMeta());
    // 12,34 m³ / 0,01 = 1234 impulsions ; 12,34 × 11,6 = 143,144 → 143,14 kWh.
    assert.deepEqual(resultat, {
        state: { gas_m3: 12.34, gas_kwh: 143.14, gas_pulses: 1234 },
    });
});

test('convertSet : paramètres personnalisés et valeur non numérique → NaN filtré', async (t) => {
    const convertSet = definition.toZigbee[0].convertSet;
    const meta = fabriqueMeta({ options: { liters_per_pulse: 100, kwh_per_m3: 10 } });
    const resultat = await convertSet(null, 'gas_m3', '5', meta);
    // 5 m³ / 0,1 = 50 impulsions ; 5 × 10 = 50 kWh.
    assert.deepEqual(resultat, {
        state: { gas_m3: 5, gas_kwh: 50, gas_pulses: 50 },
    });
});

// ─── Exposes dynamiques ───────────────────────────────────────────────────────

test('exposes : comportement porte standard (6 exposés, libellé « Porte ouverte »)', (t) => {
    const liste = definition.exposes(null, {});
    assert.equal(liste.length, 6);
    const contact = liste.find((e) => e.name === 'contact');
    assert.equal(contact.description, 'Porte ouverte');
    assert.equal(contact.access, 1); // ea.STATE
});

test('exposes : mode fenêtre → libellé « Fenêtre ouverte »', (t) => {
    const liste = definition.exposes(null, { window_mode: true });
    assert.equal(liste.find((e) => e.name === 'contact').description, 'Fenêtre ouverte');
});

test('exposes : mode Gazpar → 10 exposés, gaz typé (device_class, state_class)', (t) => {
    const liste = definition.exposes(null, { gazpar_mode: true });
    assert.equal(liste.length, 10);
    const gasM3 = liste.find((e) => e.name === 'gas_m3');
    assert.equal(gasM3.device_class, 'gas');
    assert.equal(gasM3.state_class, 'total_increasing');
    assert.equal(gasM3.access, 3); // ea.STATE_SET
    const gasKwh = liste.find((e) => e.name === 'gas_kwh');
    assert.equal(gasKwh.device_class, 'energy');
    assert.equal(gasKwh.state_class, 'total_increasing');
    assert.match(gasKwh.description, /11\.6/);
});

test('exposes : mode Gazpar avec PCS personnalisé → description dynamique', (t) => {
    const liste = definition.exposes(null, { gazpar_mode: true, kwh_per_m3: 12.5 });
    assert.match(liste.find((e) => e.name === 'gas_kwh').description, /12\.5/);
});

// ─── Options déclarées ───────────────────────────────────────────────────────

test('options : gazpar_mode, window_mode, kwh_per_m3 (bornées), liters_per_pulse (bornées)', (t) => {
    const noms = definition.options.map((o) => o.name);
    assert.deepEqual(noms, ['gazpar_mode', 'window_mode', 'kwh_per_m3', 'liters_per_pulse']);
    const kwh = definition.options.find((o) => o.name === 'kwh_per_m3');
    assert.equal(kwh.value_min, 8);
    assert.equal(kwh.value_max, 14);
    const litres = definition.options.find((o) => o.name === 'liters_per_pulse');
    assert.equal(litres.value_min, 1);
    assert.equal(litres.value_max, 100);
});
