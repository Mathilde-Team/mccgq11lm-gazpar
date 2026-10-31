// SPDX-License-Identifier: MIT
'use strict';

// Conformité SOCLE.md §1 (issue #5) : en-têtes SPDX, métadonnées package.json,
// version SemVer unique, fichier LICENSE cohérent avec la licence retenue.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const racine = path.join(__dirname, '..');

test('package.json : licence MIT et version SemVer unique', async (t) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(racine, 'package.json'), 'utf8'));
    t.assert.equal(pkg.license, 'MIT', 'champ license attendu : MIT');
    t.assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'version au format X.Y.Z');
});

test('LICENSE : texte officiel MIT à la racine', async () => {
    const licence = fs.readFileSync(path.join(racine, 'LICENSE'), 'utf8');
    assert.ok(licence.startsWith('MIT License'), 'le fichier LICENSE doit commencer par « MIT License »');
    assert.ok(licence.includes('Permission is hereby granted'), 'texte officiel MIT absent');
});

test('en-têtes SPDX MIT en tête de chaque fichier de code', async (t) => {
    const fichiers = ['mccgq11lm_gazpar.js', 'tests/mccgq11lm_gazpar.test.js', 'tests/spdx_metadonnees.test.js'];
    for (const f of fichiers) {
        const contenu = fs.readFileSync(path.join(racine, f), 'utf8');
        const premiereLigne = contenu.split('\n')[0];
        t.assert.match(
            premiereLigne,
            /^\/\/ SPDX-License-Identifier: MIT$/,
            `${f} doit commencer par l'en-tête SPDX MIT`,
        );
    }
});

test("scripts du socle : en-têtes SPDX GPL-3.0-or-later (code de l'équipe)", async (t) => {
    const scripts = ['scripts/appliquer_socle.sh', 'scripts/check_branch_protection.py'];
    for (const f of scripts) {
        const contenu = fs.readFileSync(path.join(racine, f), 'utf8');
        t.assert.ok(
            contenu
                .split('\n')
                .slice(0, 3)
                .some((l) => l.includes('SPDX-License-Identifier: GPL-3.0-or-later')),
            `${f} doit porter l'en-tête SPDX GPL-3.0-or-later`,
        );
    }
});
