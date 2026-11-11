# Journal des modifications

## 0.2.3 — 2026-11-11

- Chaque tour télécharge désormais les vidéos de la plus ancienne à la plus récente, clips courts et enregistrements continus mélangés. Avant, les clips courts partaient du plus récent. Le tri se fait sur l'heure contenue dans le nom du fichier (AAAAMMJJ-HHMMSS). La carte SD écrase ses fichiers les plus anciens en premier : ce sont eux qu'il faut sauver d'abord.
- Quand le quota disque (`max_gb`) est atteint, seuls les enregistrements continus attendent le tour suivant. Les clips courts continuent d'être téléchargés, alors qu'avant le tour s'arrêtait entièrement.

## 0.2.2 — 2026-11-11

- Une page de la liste de la carte SD qui ne répond pas est réessayée une fois sur une nouvelle session, puis ignorée. Avant, le tour entier s'arrêtait. Au-delà de 5 pages sans réponse, le tour continue avec la liste partielle.

## 0.2.1 — 2026-11-11

- Après un téléchargement bloqué, l'add-on libère le canal de téléchargement de la caméra (pause puis fermeture propre de la session).
- La réponse « occupée » de la caméra (state=3) n'est plus comptée comme un échec : l'add-on attend 1 min et réessaie, pendant 10 min au plus. Cela supprime la cascade d'erreurs « refused state=3 ».

## 0.2.0 — 2026-11-11

- Option `continuous` : récupère aussi les enregistrements continus dans `continu/AAAA-MM-JJ/`.
- Option `max_gb` : quota disque pour ces enregistrements.
- Les noms listés dans `already_on_pc.txt` (écrit par le PC) ne sont jamais téléchargés.

## 0.1.1 — 2026-11-10

- Mémorise les clips déjà récupérés dans `/data/fetched.json`, pour que le PC puisse les déplacer hors du Raspberry sans qu'ils soient téléchargés de nouveau.

## 0.1.0 — 2026-11-10

- Première version : téléchargement horaire des clips de la carte SD de la caméra vers `/media/boite_aux_lettres/`, et suppression des copies locales après `keep_days`. Image préconstruite, rien n'est compilé sur le Raspberry.
