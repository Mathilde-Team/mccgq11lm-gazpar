# Socle Mathilde-Team : les mêmes commandes que la CI (issue #6).
.PHONY: lint format test test:coverage

lint:
	npm run lint

format:
	npm run format

test:
	npm run test

test:coverage:
	npm run test:coverage
