#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Applique le socle qualité Mathilde-Team à un dépôt créé depuis modele-depot :
#   - branche `dev` créée depuis `main` si absente ;
#   - protections de `main` et `dev` appliquées depuis la règle versionnée
#     DU DÉPÔT CIBLE (<depot>/.github/branch-protection/<branche>.json, lue sur
#     `dev` puis `main`) ; la règle générique de ce dépôt n'est utilisée que si
#     le dépôt cible n'en a pas (#5) ;
#   - refus d'appliquer une règle dont un contrôle requis n'est produit par
#     aucun job des workflows du dépôt cible (sinon plus aucune PR n'est
#     fusionnable).
#
# Usage (administrateur du dépôt, gh authentifié) :
#   scripts/appliquer_socle.sh Mathilde-Team/<depot>
#
# À relancer après toute modification des règles versionnées. Idempotent.
set -euo pipefail

depot="${1:?usage : $0 <owner>/<depot>}"
generique="$(cd "$(dirname "$0")/.." && pwd)/.github/branch-protection"
travail="$(mktemp -d)"
trap 'rm -rf "$travail"' EXIT

defaut="$(gh api "repos/$depot" --jq .default_branch)"
if [ "$defaut" != "main" ]; then
  echo "Branche par défaut « $defaut » : le socle attend « main »." >&2
  exit 1
fi

if gh api "repos/$depot/branches/dev" > /dev/null 2>&1; then
  echo "dev : déjà présente"
else
  sha="$(gh api "repos/$depot/git/ref/heads/main" --jq .object.sha)"
  gh api -X POST "repos/$depot/git/refs" -f ref=refs/heads/dev -f sha="$sha" > /dev/null
  echo "dev : créée depuis main ($sha)"
fi

# Noms des jobs (clé `name:`) de tous les workflows du dépôt cible, sur dev et main.
jobs="$travail/jobs.txt"
: > "$jobs"
for ref in dev main; do
  for chemin in $(gh api "repos/$depot/contents/.github/workflows?ref=$ref" --jq '.[].path' 2>/dev/null); do
    gh api "repos/$depot/contents/$chemin?ref=$ref" --jq .content | base64 -d \
      | sed -n 's/^    name: *//p' | sed 's/^"\(.*\)"$/\1/; s/^'\''\(.*\)'\''$/\1/' >> "$jobs"
  done
done

for branche in main dev; do
  regle="$travail/$branche.json"
  origine=""
  for ref in dev main; do
    if gh api "repos/$depot/contents/.github/branch-protection/$branche.json?ref=$ref" --jq .content 2>/dev/null \
        | base64 -d > "$regle" 2>/dev/null && [ -s "$regle" ]; then
      origine="$depot@$ref:.github/branch-protection/$branche.json"
      break
    fi
  done
  if [ -z "$origine" ]; then
    cp "$generique/$branche.json" "$regle"
    origine="règle générique ($generique/$branche.json)"
  fi

  manquants="$(python3 - "$regle" "$jobs" <<'PY'
import json, sys
regle = json.load(open(sys.argv[1], encoding="utf-8"))
jobs = set(open(sys.argv[2], encoding="utf-8").read().splitlines())
checks = (regle.get("required_status_checks") or {}).get("checks") or []
print("\n".join(c["context"] for c in checks if c["context"] not in jobs))
PY
)"
  if [ -n "$manquants" ]; then
    echo "$branche : règle NON appliquée ($origine)." >&2
    echo "  Contrôle(s) requis produit(s) par aucun job du dépôt :" >&2
    printf '    - %s\n' "$manquants" >&2
    echo "  Versionner une règle propre au dépôt (.github/branch-protection/$branche.json) avec les vrais noms de jobs." >&2
    exit 1
  fi

  gh api -X PUT "repos/$depot/branches/$branche/protection" --input "$regle" > /dev/null
  echo "$branche : protection appliquée ($origine)"
done

echo "Socle appliqué à $depot. Vérification : workflow « Protection des branches »."
# Rappel de la règle de couverture (SOCLE.md §4, Mathilde-Team/.github#9) :
# elle n'est pas appliquée par ce script, mais par le job Qualité du dépôt.
echo "Couverture : seuil bloquant 95 % (branches comprises), déclaré une fois dans pyproject.toml"
echo "  ([tool.coverage.report] fail_under). Dépôt existant sous 95 % : fail_under = mesure du jour,"
echo "  relevé à chaque PR de tests jusqu'à 95 ; palier et date cible dans l'issue de suivi."
