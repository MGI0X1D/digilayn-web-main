# Digilayn

Digilayn is Musa Mgijima's software business. We build practical mobile apps, web portals, dashboards, and internal tools that help growing businesses move from manual workflows to digital systems.

This repository contains Digilayn's main website: our services, founder profile, portfolio, and project support pages.

- **Website:** [www.digilayn.com](https://www.digilayn.com/)
- **Contact:** [digilayn@gmail.com](mailto:digilayn@gmail.com)

## Website Structure

- `index.html` — business homepage and services.
- `mgijima.html` — founder profile.
- `portfolio.html` — portfolio overview.
- `portfolio/projects/` — project pages, administration screens, and LaynFleet privacy, terms, and account-deletion pages.
- `scripts/`, `styles/`, `img/`, and `favicon/` — shared scripts and assets.

The website uses static HTML, CSS, and JavaScript, with Firebase-backed functionality. GitHub Pages serves the site directly from `main` at the repository root; there is no local build step.

## Single Source of Truth

The only active local checkout is:

```text
/Users/lincoln.mgijima/Digilayn/Web/web-digilayn
```

Do not resume work in the retired `WebstormProjects/web-digilayn` copy. Firebase Cloud Functions belong in `/Users/lincoln.mgijima/Digilayn/Firebase/Backend/functions/`, not in this repository.

## Two GitHub Copies, One Workflow

- [usrmusa/digilayn-web-main](https://github.com/usrmusa/digilayn-web-main) — primary development repository and fetch source.
- [MGI0X1D/digilayn-web-main](https://github.com/MGI0X1D/digilayn-web-main) — public hosting copy for `www.digilayn.com`.

The canonical checkout's `origin` has two push URLs. A normal push from `main` sends the same commit to both repositories:

```sh
git add <changed-files>
git commit -m "Describe the change"
git push origin main
```

Keep `CNAME` set to `www.digilayn.com`. The hosting copy publishes `main` from `/`. Do not enable a competing Pages deployment or change DNS as part of routine synchronization.

### Configure a Fresh Checkout

Remote configuration is local to each checkout; it is not included in commits. From a fresh clone, configure:

```sh
git remote set-url origin https://github.com/usrmusa/digilayn-web-main.git
git config --local --replace-all remote.origin.pushurl https://github.com/usrmusa/digilayn-web-main.git
git config --local --add remote.origin.pushurl https://github.com/MGI0X1D/digilayn-web-main.git
git config --local remote.pushDefault origin
git config --local push.default simple
git remote -v
```

Authentication needs push access to both accounts' repositories. Two-server pushes are not atomic: one can succeed while the other fails. Read both push results and retry after fixing any failure; do not force-push to hide a divergence. Avoid editing either copy independently on GitHub. This setup synchronizes local pushes, not changes made elsewhere automatically.

## Local Preview

Serve the repository with WebStorm's local web server or another static HTTP server. Firebase-backed pages still require the appropriate authentication and permissions. Never commit credentials, service-account keys, or private account records: everything pushed here is also published to the public hosting repository.
