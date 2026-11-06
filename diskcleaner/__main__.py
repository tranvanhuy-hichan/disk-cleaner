import sys

if len(sys.argv) > 1 and sys.argv[1] == 'scan':
    from .scanner import main
    main()
else:
    from .app import main
    sys.exit(main())
