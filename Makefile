# Сборка и установка Backup Manager

PKG_NAME = backup-manager

.PHONY: all build install rpm deb deb-build clean setup help

all: build

# Сборка веб-приложения
build:
	@echo "=== Сборка веб-приложения ==="
	npm ci
	npm run build
	@echo "✓ Сборка завершена"

# Установка локально (без RPM)
install: build
	@echo "=== Локальная установка ==="
	sudo mkdir -p /usr/share/$(PKG_NAME)/web
	sudo mkdir -p /usr/share/$(PKG_NAME)/scripts
	sudo mkdir -p /usr/share/$(PKG_NAME)/server
	sudo install -d -m 755 /usr/share/icons/hicolor/scalable/apps
	sudo mkdir -p /etc/$(PKG_NAME)
	sudo mkdir -p /var/log/$(PKG_NAME)
	
	sudo cp -r dist/* /usr/share/$(PKG_NAME)/web/
	sudo install -m 644 server/index.js /usr/share/$(PKG_NAME)/server/
	sudo install -m 644 server/package.json /usr/share/$(PKG_NAME)/server/
	sudo install -m 755 rpm-build/SOURCES/backup.sh /usr/share/$(PKG_NAME)/scripts/
	sudo install -m 755 rpm-build/SOURCES/backup-all.sh /usr/share/$(PKG_NAME)/scripts/
	sudo install -m 755 rpm-build/SOURCES/mount-smb.sh /usr/share/$(PKG_NAME)/scripts/
	sudo install -m 755 rpm-build/SOURCES/setup.sh /usr/share/$(PKG_NAME)/scripts/
	sudo install -m 600 rpm-build/SOURCES/backup.conf /etc/$(PKG_NAME)/
	sudo install -m 644 rpm-build/SOURCES/backup-manager.conf /etc/nginx/conf.d/
	sudo install -m 644 rpm-build/SOURCES/backup-manager-api.service /usr/lib/systemd/system/
	sudo install -m 644 rpm-build/SOURCES/backup-manager.desktop /usr/share/applications/
	sudo install -m 644 assets/backup-manager.svg /usr/share/icons/hicolor/scalable/apps/backup-manager.svg
	sudo update-desktop-database >/dev/null 2>&1 || true
	sudo install -d -m 700 /var/lib/backup-manager
	sudo systemctl daemon-reload
	sudo systemctl enable --now backup-manager-api.service
	sudo systemctl restart nginx.service
	
	@echo "✓ Установка завершена"
	@echo "  Выполните настройку: sudo /usr/share/$(PKG_NAME)/scripts/setup.sh"

# Сборка RPM пакета
rpm:
	bash ./rpm-build/build-rpm.sh

# Сборка Debian пакета
deb deb-build:
	bash ./deb-build/build-deb.sh

# Первоначальная настройка
setup:
	sudo /usr/share/$(PKG_NAME)/scripts/setup.sh

# Очистка
clean:
	rm -rf dist node_modules
	rm -rf ~/rpmbuild/BUILD/*
	@echo "✓ Очищено"

# Полная очистка (включая rpmbuild)
distclean: clean
	rm -rf ~/rpmbuild
	@echo "✓ Полная очистка завершена"

# Справка
help:
	@echo "Доступные команды:"
	@echo "  make build    - Сборка веб-приложения"
	@echo "  make install  - Локальная установка (без RPM)"
	@echo "  make rpm      - Сборка RPM пакета"
	@echo "  make deb      - Сборка Debian пакета"
	@echo "  make deb-build - Сборка Debian пакета"
	@echo "  make setup    - Первоначальная настройка"
	@echo "  make clean    - Очистка временных файлов"
	@echo "  make distclean - Полная очистка"
	@echo "  make help     - Показать эту справку"
