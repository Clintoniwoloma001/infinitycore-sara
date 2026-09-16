# INFINITYCORE BANK — SOURCE DATA AND PERFORMANCE DEFAULTS

Authoritative source workbook: `IT AUTOMATION LIST.xlsx` (employee master data),
plus performance/bonus/grade definitions from `INFINITY MFB INDUCTION SLIDES FOR FINCON.pptx`.

This file is the source of truth for the HR master-data import (Phase 26). Values below
must be preserved EXACTLY on import. Where the source is ambiguous, that is flagged and
recorded in `data_quality_exceptions` — values are never invented.

---

## 1. STAFF MASTER DATA

215 staff records. Confirmation status counts: CONFIRMED = 170, UNCONFIRMED = 44,
CONTRACT STAFF = 1 (total 215).

| S/N | STAFF ID | FULL NAME | EMAIL ADDRESS | DESIGNATION | DEPARTMENT | BRANCH | 1ST SUPERVISOR | 2ND SUPERVISOR | 3RD SUPERVISOR | CONFIRMATION STATUS | HIRED DATE |
|----:|----------|-----------|---------------|-------------|------------|--------|----------------|----------------|----------------|---------------------|------------|
| 1 | IMFB-KH-001 | Amaka Nwosu | amaka.nwosu@infinitycorebank.com | AREA MANAGER (AREA 1) | CREDIT & MARKETING | BARIGA/LAGOS Island 1 | Anita Okoro | — | — | CONFIRMED | 12/03/2019 |
| 2 | IMFB-KH-002 | Uche Obi | uche.obi@infinitycorebank.com | BRANCH MANAGER | CREDIT & MARKETING | BARIGA/LAGOS Island 1 | Amaka Nwosu | Anita Okoro | — | CONFIRMED | 21/07/2020 |
| 3 | IMFB-KH-003 | Kelechi Eze | kelechi.eze@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | BARIGA/LAGOS Island 1 | Uche Obi | Amaka Nwosu | Anita Okoro | UNCONFIRMED | 05/02/2022 |
| 4 | IMFB-KH-004 | Adaeze Okonkwo | adaeze.okonkwo@infinitycorebank.com | SENIOR SME OFFICER | CREDIT & MARKETING | LAGOS ISLAND 2/IBEJU -LEKKI/AJAH | Nnenna Ibe | — | — | CONFIRMED | 14/09/2018 |
| 5 | IMFB-KH-005 | Nnenna Ibe | nnenna.ibe@infinitycorebank.com | AREA MANAGER (AREA 1) | CREDIT & MARKETING | LAGOS ISLAND 2/IBEJU -LEKKI/AJAH | Anita Okoro | — | — | CONFIRMED | 30/01/2019 |
| 6 | IMFB-KH-006 | Emeka Okafor | emeka.okafor@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | LAGOS ISLAND 2/IBEJU -LEKKI/AJAH | Adaeze Okonkwo | Nnenna Ibe | Anita Okoro | UNCONFIRMED | 17/06/2022 |
| 7 | IMFB-KH-007 | Chiamaka Nwoye | chiamaka.nwoye@infinitycorebank.com | SME OFFICER | CREDIT & MARKETING | TRADE FAIR/BOUNDARY/ALABA | Ifeanyi Ohaka | — | — | CONFIRMED | 08/12/2016 |
| 8 | IMFB-KH-008 | Ifeanyi Ohaka | ifeanyi.ohaka@infinitycorebank.com | BRANCH MANAGER | CREDIT & MARKETING | TRADE FAIR/BOUNDARY/ALABA | Blessing Akpan | — | — | UNCONFIRMED | 03/05/2021 |
| 9 | IMFB-KH-009 | Blessing Akpan | blessing.akpan@infinitycorebank.com | AREA MANAGER (AREA 1) | CREDIT & MARKETING | TRADE FAIR/BOUNDARY/ALABA | Anita Okoro | — | — | CONFIRMED | 26/10/2018 |
| 10 | IMFB-KH-010 | Tunde Bakare | tunde.bakare@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | AGEGE & EGBEDA | Yetunde Lawal | — | — | CONFIRMED | 19/08/2019 |
| 11 | IMFB-KH-011 | Yetunde Lawal | yetunde.lawal@infinitycorebank.com | BRANCH MANAGER | CREDIT & MARKETING | AGEGE & EGBEDA | Chinedu Obi | — | — | CONFIRMED | 11/03/2015 |
| 12 | IMFB-KH-012 | Chinedu Obi | chinedu.obi@infinitycorebank.com | AREA MANAGER (AREA 1) | CREDIT & MARKETING | AGEGE & EGBEDA | Anita Okoro | — | — | CONFIRMED | 02/06/2017 |
| 13 | IMFB-KH-013 | Halima Suleiman | halima.suleiman@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | MUSHIN/YABA | Segun Adeyemi | — | — | UNCONFIRMED | 23/02/2023 |
| 14 | IMFB-KH-014 | Segun Adeyemi | segun.adeyemi@infinitycorebank.com | BRANCH MANAGER | CREDIT & MARKETING | MUSHIN/YABA | Adebayo Thomas | — | — | CONFIRMED | 15/11/2016 |
| 15 | IMFB-KH-015 | Adebayo Thomas | adebayo.thomas@infinitycorebank.com | AREA MANAGER (AREA 2) | CREDIT & MARKETING | MUSHIN/YABA | Oluwaseun Adeleke | — | — | CONFIRMED | 09/05/2019 |
| 16 | IMFB-KH-016 | Ngozi Okoro | ngozi.okoro@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | MUSHIN/YABA | Segun Adeyemi | Adebayo Thomas | Oluwaseun Adeleke | CONTRACT STAFF | 01/04/2023 |
| 17 | IMFB-KH-017 | Bolanle Ajayi | bolanle.ajayi@infinitycorebank.com | SME OFFICER | CREDIT & MARKETING | KETU & HEAD OFFICE | Adebayo Thomas | — | — | CONFIRMED | 12/02/2018 |
| 18 | IMFB-KH-018 | Ireti Adewale | ireti.adewale@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | KETU & HEAD OFFICE | Chukwuma Ogbechie | — | — | UNCONFIRMED | 14/07/2022 |
| 19 | IMFB-KH-019 | Chukwuma Ogbechie | chukwuma.ogbechie@infinitycorebank.com | BRANCH MANAGER | CREDIT & MARKETING | KETU & HEAD OFFICE | Oluwaseun Adeleke | — | — | CONFIRMED | 27/01/2020 |
| 20 | IMFB-KH-020 | Oluwaseun Adeleke | oluwaseun.adeleke@infinitycorebank.com | AREA MANAGER (AREA 2) | CREDIT & MARKETING | KETU & HEAD OFFICE | Bisi Ajayi | — | — | CONFIRMED | 18/08/2014 |
| 21 | IMFB-KH-021 | Kafayat Bello | kafayat.bello@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | KOLA & ILE-EPO | Opeyemi Adesina | — | — | CONFIRMED | 25/09/2019 |
| 22 | IMFB-KH-022 | Opeyemi Adesina | opeyemi.adesina@infinitycorebank.com | BRANCH MANAGER | CREDIT & MARKETING | KOLA & ILE-EPO | Amaka Nwosu | — | — | CONFIRMED | 10/06/2019 |
| 23 | IMFB-KH-023 | Funmilayo Balogun | funmilayo.balogun@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | OSHODI & IKEJA | Adaeze Okonkwo | — | — | UNCONFIRMED | 28/03/2023 |
| 24 | IMFB-KH-024 | Adaeze Okafor | adaeze.okafor@infinitycorebank.com | BRANCH MANAGER | CREDIT & MARKETING | OSHODI & IKEJA | Nnenna Ibe | — | — | CONFIRMED | 13/07/2020 |
| 25 | IMFB-KH-025 | Olayemi Adenuga | olayemi.adenuga@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | OSHODI & IKEJA | Adaeze Okafor | Nnenna Ibe | Anita Okoro | CONFIRMED | 05/12/2021 |
| 26 | IMFB-KH-026 | Sule Ameh | sule.ameh@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | OSHODI & IKEJA | Adaeze Okafor | Nnenna Ibe | Anita Okoro | UNCONFIRMED | 20/06/2022 |
| 27 | IMFB-KH-027 | Chinwe Ekwueme | chinwe.ekwueme@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | LAGOS ISLAND 2/IBEJU -LEKKI/AJAH | Adaeze Okonkwo | Nnenna Ibe | Anita Okoro | CONFIRMED | 11/10/2020 |
| 28 | IMFB-KH-028 | Bisi Ajayi | bisi.ajayi@infinitycorebank.com | AREA MANAGER (AREA 2) | CREDIT & MARKETING | LAGOS ISLAND 2/IBEJU -LEKKI/AJAH | Anita Okoro | — | — | CONFIRMED | 22/04/2016 |
| 29 | IMFB-KH-029 | Grace Eze | grace.eze@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | BARIGA/LAGOS Island 1 | Uche Obi | Amaka Nwosu | Anita Okoro | CONFIRMED | 09/01/2020 |
| 30 | IMFB-KH-030 | Peter Sunday | peter.sunday@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | AGEGE & EGBEDA | Yetunde Lawal | Chinedu Obi | Anita Okoro | UNCONFIRMED | 16/11/2022 |
| 31 | IMFB-KH-031 | Aisha Mohammed | aisha.mohammed@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | TRADE FAIR/BOUNDARY/ALABA | Ifeanyi Ohaka | Blessing Akpan | Anita Okoro | CONFIRMED | 06/05/2021 |
| 32 | IMFB-KH-032 | Ibrahim Musa | ibrahim.musa@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | AGEGE & EGBEDA | Yetunde Lawal | Chinedu Obi | Anita Okoro | CONFIRMED | 18/10/2021 |
| 33 | IMFB-KH-033 | Folake Adeyemi | folake.adeyemi@infinitycorebank.com | SENIOR LOAN OFFICER | CREDIT & MARKETING | BARIGA/LAGOS Island 1 | Uche Obi | Amaka Nwosu | Anita Okoro | CONFIRMED | 02/08/2017 |
| 34 | IMFB-KH-034 | Celestine Okoye | celestine.okoye@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | KOLA & ILE-EPO | Opeyemi Adesina | Amaka Nwosu | — | UNCONFIRMED | 12/09/2022 |
| 35 | IMFB-KH-035 | Abiodun Alabi | abiodun.alabi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | MUSHIN/YABA | Segun Adeyemi | Adebayo Thomas | Oluwaseun Adeleke | CONFIRMED | 24/03/2020 |
| 36 | IMFB-KH-036 | Nnamdi Okafor | nnamdi.okafor@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | KETU & HEAD OFFICE | Chukwuma Ogbechie | Oluwaseun Adeleke | Bisi Ajayi | CONFIRMED | 29/07/2019 |
| 37 | IMFB-KH-037 | Aderonke Oladele | aderonke.oladele@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | KOLA & ILE-EPO | Opeyemi Adesina | Amaka Nwosu | — | UNCONFIRMED | 15/08/2022 |
| 38 | IMFB-KH-038 | Ayodeji Olawale | ayodeji.olawale@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | LAGOS ISLAND 2/IBEJU -LEKKI/AJAH | Adaeze Okonkwo | Nnenna Ibe | Anita Okoro | CONFIRMED | 30/04/2020 |
| 39 | IMFB-KH-039 | Mary Olayinka | mary.olayinka@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | OSHODI & IKEJA | Adaeze Okafor | Nnenna Ibe | Anita Okoro | CONFIRMED | 07/06/2021 |
| 40 | IMFB-KH-040 | Tobi Adewumi | tobi.adewumi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | BARIGA/LAGOS Island 1 | Uche Obi | Amaka Nwosu | Anita Okoro | UNCONFIRMED | 11/03/2023 |
| 41 | IMFB-KH-041 | Chidera Obi | chidera.obi@infinitycorebank.com | SME OFFICER | CREDIT & MARKETING | LAGOS ISLAND 2/IBEJU -LEKKI/AJAH | Adaeze Okonkwo | Nnenna Ibe | Anita Okoro | CONFIRMED | 19/02/2018 |
| 42 | IMFB-KH-042 | Fatima Bello | fatima.bello@infinitycorebank.com | SME OFFICER | CREDIT & MARKETING | TRADE FAIR/BOUNDARY/ALABA | Ifeanyi Ohaka | Blessing Akpan | Anita Okoro | CONFIRMED | 10/11/2020 |
| 43 | IMFB-KH-043 | Adewale Adeyemi | adewale.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | MUSHIN/YABA | Segun Adeyemi | Adebayo Thomas | Oluwaseun Adeleke | CONFIRMED | 27/04/2021 |
| 44 | IMFB-KH-044 | Oluwafemi Omotayo | oluwafemi.omotayo@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | AGEGE & EGBEDA | Yetunde Lawal | Chinedu Obi | Anita Okoro | UNCONFIRMED | 21/09/2022 |
| 45 | IMFB-KH-045 | Chioma Umeh | chioma.umeh@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | KOLA & ILE-EPO | Opeyemi Adesina | Amaka Nwosu | — | CONFIRMED | 08/04/2021 |
| 46 | IMFB-KH-046 | Kanayo Nduka | kanayo.nduka@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | KETU & HEAD OFFICE | Chukwuma Ogbechie | Oluwaseun Adeleke | Bisi Ajayi | UNCONFIRMED | 14/12/2022 |
| 47 | IMFB-KH-047 | Ngozi Okafor | ngozi.okafor@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | OSHODI & IKEJA | Adaeze Okafor | Nnenna Ibe | Anita Okoro | CONFIRMED | 03/02/2020 |
| 48 | IMFB-KH-048 | Samuel Adebayo | samuel.adebayo@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | LAGOS ISLAND 2/IBEJU -LEKKI/AJAH | Adaeze Okonkwo | Nnenna Ibe | Anita Okoro | CONFIRMED | 26/07/2021 |
| 49 | IMFB-KH-049 | Omolara Adewole | omolara.adewole@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | BARIGA/LAGOS Island 1 | Uche Obi | Amaka Nwosu | Anita Okoro | CONFIRMED | 17/05/2019 |
| 50 | IMFB-KH-050 | Abubakar Sani | abubakar.sani@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | AGEGE & EGBEDA | Yetunde Lawal | Chinedu Obi | Anita Okoro | CONFIRMED | 13/02/2023 |
| 51 | IMFB-KH-051 | Abimbola Odu | abimbola.odu@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | TRADE FAIR/BOUNDARY/ALABA | Ifeanyi Ohaka | Blessing Akpan | Anita Okoro | UNCONFIRMED | 06/03/2023 |
| 52 | IMFB-KH-052 | Oluwaseun Ogun | oluwaseun.ogun@infinitycorebank.com | SME OFFICER | CREDIT & MARKETING | MUSHIN/YABA | Segun Adeyemi | Adebayo Thomas | Oluwaseun Adeleke | CONFIRMED | 20/04/2020 |
| 53 | IMFB-KH-053 | Ezinne Anyanwu | ezinne.anyanwu@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | KOLA & ILE-EPO | Opeyemi Adesina | Amaka Nwosu | — | CONFIRMED | 22/08/2019 |
| 54 | IMFB-KH-054 | Temitope Adeola | temitope.adeola@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | KETU & HEAD OFFICE | Chukwuma Ogbechie | Oluwaseun Adeleke | Bisi Ajayi | UNCONFIRMED | 25/10/2022 |
| 55 | IMFB-KH-055 | Yetunde Akinola | yetunde.akinola@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | OSHODI & IKEJA | Adaeze Okafor | Nnenna Ibe | Anita Okoro | CONFIRMED | 28/06/2021 |
| 56 | IMFB-KH-056 | Ibrahim Lawal | ibrahim.lawal@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | LAGOS ISLAND 2/IBEJU -LEKKI/AJAH | Adaeze Okonkwo | Nnenna Ibe | Anita Okoro | CONFIRMED | 09/03/2020 |
| 57 | IMFB-KH-057 | Oluchi Obi | oluchi.obi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | BARIGA/LAGOS Island 1 | Uche Obi | Amaka Nwosu | Anita Okoro | CONFIRMED | 16/01/2023 |
| 58 | IMFB-KH-058 | Zakari Aliyu | zakari.aliyu@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | AGEGE & EGBEDA | Yetunde Lawal | Chinedu Obi | Anita Okoro | CONFIRMED | 23/09/2019 |
| 59 | IMFB-KH-059 | Chioma Nwosu | chioma.nwosu@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | TRADE FAIR/BOUNDARY/ALABA | Ifeanyi Ohaka | Blessing Akpan | Anita Okoro | UNCONFIRMED | 04/08/2022 |
| 60 | IMFB-KH-060 | Babatunde Ojo | babatunde.ojo@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | MUSHIN/YABA | Segun Adeyemi | Adebayo Thomas | Oluwaseun Adeleke | CONFIRMED | 12/12/2018 |
| 61 | IMFB-KH-061 | Nkechi Eze | nkechi.eze@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | KOLA & ILE-EPO | Opeyemi Adesina | Amaka Nwosu | — | CONFIRMED | 05/07/2020 |
| 62 | IMFB-KH-062 | Gbenga Adeleke | gbenga.adeleke@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | KETU & HEAD OFFICE | Chukwuma Ogbechie | Oluwaseun Adeleke | Bisi Ajayi | UNCONFIRMED | 18/05/2022 |
| 63 | IMFB-KH-063 | Amina Yusuf | amina.yusuf@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | OSHODI & IKEJA | Adaeze Okafor | Nnenna Ibe | Anita Okoro | CONFIRMED | 07/11/2019 |
| 64 | IMFB-KH-064 | Tobiloba Adeyemi | tobiloba.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | LAGOS ISLAND 2/IBEJU -LEKKI/AJAH | Adaeze Okonkwo | Nnenna Ibe | Anita Okoro | CONFIRMED | 30/05/2021 |
| 65 | IMFB-KH-065 | Umar Farouk | umar.farouk@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | BARIGA/LAGOS Island 1 | Uche Obi | Amaka Nwosu | Anita Okoro | CONFIRMED | 14/10/2020 |
| 66 | IMFB-KH-066 | Adeola Ogunleye | adeola.ogunleye@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | AGEGE & EGBEDA | Yetunde Lawal | Chinedu Obi | Anita Okoro | UNCONFIRMED | 19/01/2022 |
| 67 | IMFB-KH-067 | Ijeoma Uzochukwu | ijeoma.uzochukwu@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | TRADE FAIR/BOUNDARY/ALABA | Ifeanyi Ohaka | Blessing Akpan | Anita Okoro | CONFIRMED | 26/04/2021 |
| 68 | IMFB-KH-068 | Femi Adewusi | femi.adewusi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | MUSHIN/YABA | Segun Adeyemi | Adebayo Thomas | Oluwaseun Adeleke | CONFIRMED | 02/11/2020 |
| 69 | IMFB-KH-069 | Chukwuemeka Eze | chukwuemeka.eze@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | KOLA & ILE-EPO | Opeyemi Adesina | Amaka Nwosu | — | UNCONFIRMED | 22/02/2023 |
| 70 | IMFB-KH-070 | Titilayo Adewale | titilayo.adewale@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | KETU & HEAD OFFICE | Chukwuma Ogbechie | Oluwaseun Adeleke | Bisi Ajayi | CONFIRMED | 09/08/2018 |
| 71 | IMFB-KH-071 | Danladi Ibrahim | danladi.ibrahim@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | OSHODI & IKEJA | Adaeze Okafor | Nnenna Ibe | Anita Okoro | CONFIRMED | 24/12/2020 |
| 72 | IMFB-KH-072 | Oluwatoyin Adebayo | oluwatoyin.adebayo@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | LAGOS ISLAND 2/IBEJU -LEKKI/AJAH | Adaeze Okonkwo | Nnenna Ibe | Anita Okoro | CONFIRMED | 17/03/2022 |
| 73 | IMFB-KH-073 | Aliyu Abubakar | aliyu.abubakar@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | BARIGA/LAGOS Island 1 | Uche Obi | Amaka Nwosu | Anita Okoro | UNCONFIRMED | 08/06/2022 |
| 74 | IMFB-KH-074 | Oluwaseun Adeleke | oluwaseun.adeleke2@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | AGEGE & EGBEDA | Yetunde Lawal | Chinedu Obi | Anita Okoro | CONFIRMED | 11/01/2021 |
| 75 | IMFB-KH-075 | Kemi Oloruntoba | kemi.oloruntoba@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | TRADE FAIR/BOUNDARY/ALABA | Ifeanyi Ohaka | Blessing Akpan | Anita Okoro | CONFIRMED | 29/09/2019 |
| 76 | IMFB-KH-076 | Adeyosola Oyetola | adeyosola.oyetola@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | MUSHIN/YABA | Segun Adeyemi | Adebayo Thomas | Oluwaseun Adeleke | UNCONFIRMED | 01/03/2023 |
| 77 | IMFB-KH-077 | Ngozi Nnamdi | ngozi.nnamdi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | KOLA & ILE-EPO | Opeyemi Adesina | Amaka Nwosu | — | CONFIRMED | 21/10/2021 |
| 78 | IMFB-KH-078 | Yakubu Garba | yakubu.garba@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | KETU & HEAD OFFICE | Chukwuma Ogbechie | Oluwaseun Adeleke | Bisi Ajayi | CONFIRMED | 13/06/2019 |
| 79 | IMFB-KH-079 | Timilehin Adeola | timilehin.adeola@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | OSHODI & IKEJA | Adaeze Okafor | Nnenna Ibe | Anita Okoro | UNCONFIRMED | 04/08/2022 |
| 80 | IMFB-KH-080 | Chinonso Iheanacho | chinonso.iheanacho@infinitycorebank.com | SME OFFICER | CREDIT & MARKETING | LAGOS ISLAND 2/IBEJU -LEKKI/AJAH | Adaeze Okonkwo | Nnenna Ibe | Anita Okoro | CONFIRMED | 27/05/2019 |
| 81 | IMFB-KH-081 | Aisha Abubakar | aisha.abubakar@infinitycorebank.com | ADMIN OFFICER | ADMINISTRATION | HEAD OFFICE - OSHODI | Zainab Adeyemi | — | — | CONFIRMED | 20/09/2018 |
| 82 | IMFB-KH-082 | Zainab Adeyemi | zainab.adeyemi@infinitycorebank.com | ADMIN MANAGER | ADMINISTRATION | HEAD OFFICE - OSHODI | Ahmed Ogunwale | — | — | CONFIRMED | 05/04/2016 |
| 83 | IMFB-KH-083 | Ahmed Ogunwale | ahmed.ogunwale@infinitycorebank.com | HEAD OF OPERATIONS | OPERATIONS | HEAD OFFICE - OSHODI | Maryam Sanusi | — | — | CONFIRMED | 14/11/2013 |
| 84 | IMFB-KH-084 | Maryam Sanusi | maryam.sanusi@infinitycorebank.com | HEAD, CONTACT CENTRE | OPERATIONS | HEAD OFFICE - OSHODI | Maryam Sanusi | — | — | CONFIRMED | 18/06/2015 |
| 85 | IMFB-KH-085 | Kelechi Okafor | kelechi.okafor@infinitycorebank.com | HEAD, E-BANKING | E-BUSINESS | HEAD OFFICE - OSHODI | Ademola Olatunji | — | — | CONFIRMED | 09/02/2014 |
| 86 | IMFB-KH-086 | Ademola Olatunji | ademola.olatunji@infinitycorebank.com | HEAD OF BUSINESS | MD/CEO | HEAD OFFICE - OSHODI | Chidi Okafor | — | — | CONFIRMED | 02/10/2012 |
| 87 | IMFB-KH-087 | Chidi Okafor | chidi.okafor@infinitycorebank.com | HEAD OF DIGITAL BANKING | E-BUSINESS | HEAD OFFICE - OSHODI | Ademola Olatunji | — | — | UNCONFIRMED | 25/07/2022 |
| 88 | IMFB-KH-088 | Uloaku Nnaji | uloaku.nnaji@infinitycorebank.com | LOAN OFFICER | LOAN MONITORING & RECOVERY | HEAD OFFICE - OSHODI | Bamidele Adebayo | — | — | CONFIRMED | 12/03/2020 |
| 89 | IMFB-KH-089 | Bamidele Adebayo | bamidele.adebayo@infinitycorebank.com | HEAD, LOAN MONITORING & RECOVERY | LOAN MONITORING & RECOVERY | HEAD OFFICE - OSHODI | Tunde Adebayo | — | — | CONFIRMED | 19/08/2017 |
| 90 | IMFB-KH-090 | Tunde Adebayo | tunde.adebayo@infinitycorebank.com | HEAD OF RECOVERY | RECOVERY | HEAD OFFICE - OSHODI | Gbenga Adewale | — | — | CONFIRMED | 08/05/2015 |
| 91 | IMFB-KH-091 | Gbenga Adewale | gbenga.adewale@infinitycorebank.com | EXECUTIVE DIRECTOR | MD/CEO | HEAD OFFICE - OSHODI | — | — | — | CONFIRMED | 03/03/2011 |
| 92 | IMFB-KH-092 | Funke Ogunlesi | funke.ogunlesi@infinitycorebank.com | HEAD, HUMAN RESOURCES | HUMAN RESOURCES | HEAD OFFICE - OSHODI | Lola Akintola | — | — | CONFIRMED | 22/06/2015 |
| 93 | IMFB-KH-093 | Lola Akintola | lola.akintola@infinitycorebank.com | HR MANAGER | HUMAN RESOURCES | HEAD OFFICE - OSHODI | Funke Ogunlesi | — | — | CONFIRMED | 15/01/2018 |
| 94 | IMFB-KH-094 | Chinedu Okafor | chinedu.okafor@infinitycorebank.com | HEAD OF INTERNAL CONTROL | AUDIT & INVESTIGATION | HEAD OFFICE - OSHODI | Okon Bassey | — | — | CONFIRMED | 28/09/2014 |
| 95 | IMFB-KH-095 | Okon Bassey | okon.bassey@infinitycorebank.com | HEAD OF AUDIT | AUDIT & INVESTIGATION | HEAD OFFICE - OSHODI | Anita Okoro | — | — | CONFIRMED | 11/04/2016 |
| 96 | IMFB-KH-096 | Anita Okoro | anita.okoro@infinitycorebank.com | MD/CEO | MD/CEO | HEAD OFFICE - OSHODI | — | — | — | CONFIRMED | 06/08/2010 |
| 97 | IMFB-KH-097 | Adaeze Obi | adaeze.obi@infinitycorebank.com | HEAD, RISK MANAGEMENT | RISK & COMPLIANCE | HEAD OFFICE - OSHODI | Nkechi Eze | — | — | CONFIRMED | 13/07/2015 |
| 98 | IMFB-KH-098 | Nkechi Eze | nkechi.eze@infinitycorebank.com | HEAD OF COMPLIANCE | RISK & COMPLIANCE | HEAD OFFICE - OSHODI | Nkechi Eze | — | — | UNCONFIRMED | 24/04/2023 |
| 99 | IMFB-KH-099 | Ugochukwu Nwosu | ugochukwu.nwosu@infinitycorebank.com | FINANCIAL CONTROLLER | FINANCIAL CONTROL | HEAD OFFICE - OSHODI | Bisi Ajayi | — | — | CONFIRMED | 17/12/2014 |
| 100 | IMFB-KH-100 | Bisi Ajayi | bisi.ajayi@infinitycorebank.com | CHIEF FINANCIAL OFFICER | FINANCIAL CONTROL | HEAD OFFICE - OSHODI | Gbenga Adewale | — | — | CONFIRMED | 09/05/2012 |
| 101 | IMFB-KH-101 | Omolayo Adeyemi | omolayo.adeyemi@infinitycorebank.com | LOAN OFFICER | FINANCIAL CONTROL | HEAD OFFICE - OSHODI | Ugochukwu Nwosu | Bisi Ajayi | — | CONFIRMED | 05/10/2018 |
| 102 | IMFB-KH-102 | Kolawole Adeyemi | kolawole.adeyemi@infinitycorebank.com | LOAN OFFICER | FINANCIAL CONTROL | HEAD OFFICE - OSHODI | Ugochukwu Nwosu | Bisi Ajayi | — | UNCONFIRMED | 18/03/2022 |
| 103 | IMFB-KH-103 | Ikenna Nwachukwu | ikenna.nwachukwu@infinitycorebank.com | LOAN OFFICER | FINANCIAL CONTROL | HEAD OFFICE - OSHODI | Ugochukwu Nwosu | Bisi Ajayi | — | CONFIRMED | 27/08/2021 |
| 104 | IMFB-KH-104 | Soji Aderemi | soji.aderemi@infinitycorebank.com | ICT OFFICER | INFORMATION TECHNOLOGY | HEAD OFFICE - OSHODI | Funmilayo Adegbite | — | — | CONFIRMED | 23/01/2019 |
| 105 | IMFB-KH-105 | Funmilayo Adegbite | funmilayo.adegbite@infinitycorebank.com | HEAD OF INFORMATION TECHNOLOGY | INFORMATION TECHNOLOGY | HEAD OFFICE - OSHODI | Ademola Olatunji | — | — | CONFIRMED | 14/09/2017 |
| 106 | IMFB-KH-106 | Chibueze Okafor | chibueze.okafor@infinitycorebank.com | ICT OFFICER | INFORMATION TECHNOLOGY | HEAD OFFICE - OSHODI | Funmilayo Adegbite | — | — | CONFIRMED | 06/07/2020 |
| 107 | IMFB-KH-107 | Oluwakemi Adeyemi | oluwakemi.adeyemi@infinitycorebank.com | HEAD OF LEGAL | LEGAL | HEAD OFFICE - OSHODI | Adesina Ogunleye | — | — | CONFIRMED | 02/03/2016 |
| 108 | IMFB-KH-108 | Adesina Ogunleye | adesina.ogunleye@infinitycorebank.com | LEGAL OFFICER | LEGAL | HEAD OFFICE - OSHODI | Oluwakemi Adeyemi | — | — | UNCONFIRMED | 12/11/2021 |
| 109 | IMFB-KH-109 | Yemi Adekoya | yemi.adekoya@infinitycorebank.com | HEAD OF OTHER CREDIT UNITS | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Ademola Olatunji | — | — | CONFIRMED | 29/05/2019 |
| 110 | IMFB-KH-110 | Ahmed Bello | ahmed.bello@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 18/02/2021 |
| 111 | IMFB-KH-111 | Bukola Adeyemi | bukola.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 02/09/2022 |
| 112 | IMFB-KH-112 | Ibrahim Adeyemi | ibrahim.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 15/06/2020 |
| 113 | IMFB-KH-113 | Chinedu Onyeka | chinedu.onyeka@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 05/08/2022 |
| 114 | IMFB-KH-114 | Maryam Okafor | maryam.okafor@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 23/02/2019 |
| 115 | IMFB-KH-115 | Osaro Eghosa | osaro.eghosa@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 18/11/2022 |
| 116 | IMFB-KH-116 | Habiba Kasim | habiba.kasim@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 09/03/2022 |
| 117 | IMFB-KH-117 | Nnenna Eze | nnenna.eze@infinitycorebank.com | SME OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 01/07/2022 |
| 118 | IMFB-KH-118 | Olisa Eze | olisa.eze@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 26/04/2021 |
| 119 | IMFB-KH-119 | Zainab Bello | zainab.bello@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 14/10/2019 |
| 120 | IMFB-KH-120 | Ridwan Olamilekan | ridwan.olamilekan@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 28/06/2022 |
| 121 | IMFB-KH-121 | Abosede Lawal | abosede.lawal@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 11/05/2018 |
| 122 | IMFB-KH-122 | Musibau Adeleke | musibau.adeleke@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 03/12/2017 |
| 123 | IMFB-KH-123 | Adeola Osho | adeola.osho@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 22/01/2023 |
| 124 | IMFB-KH-124 | Emeka Nwosu | emeka.nwosu@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 16/08/2019 |
| 125 | IMFB-KH-125 | Aderemi Olajide | aderemi.olajide@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 06/04/2018 |
| 126 | IMFB-KH-126 | Samira Usman | samira.usman@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 19/09/2022 |
| 127 | IMFB-KH-127 | Ogochukwu Obi | ogochukwu.obi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 07/02/2022 |
| 128 | IMFB-KH-128 | Joseph Adebayo | joseph.adebayo@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 26/03/2023 |
| 129 | IMFB-KH-129 | Khadijat Oyedeji | khadijat.oyedeji@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 13/11/2020 |
| 130 | IMFB-KH-130 | Segun Ogunleye | segun.ogunleye@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 04/06/2022 |
| 131 | IMFB-KH-131 | Chika Obi | chika.obi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 17/01/2020 |
| 132 | IMFB-KH-132 | Nobert Adewopo | nobert.adewopo@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 29/07/2022 |
| 133 | IMFB-KH-133 | Eniola Ogunlana | eniola.ogunlana@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 10/03/2023 |
| 134 | IMFB-KH-134 | Adeola Adewale | adeola.adewale@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 21/08/2022 |
| 135 | IMFB-KH-135 | Tunde Oyerinde | tunde.oyerinde@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 15/05/2019 |
| 136 | IMFB-KH-136 | Njideka Okoli | njideka.okoli@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 02/12/2021 |
| 137 | IMFB-KH-137 | Salawu Adeleke | salawu.adeleke@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 24/02/2023 |
| 138 | IMFB-KH-138 | Ngozi Nwosu | ngozi.nwosu@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 08/08/2018 |
| 139 | IMFB-KH-139 | Waheed Adamu | waheed.adamu@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 30/04/2019 |
| 140 | IMFB-KH-140 | Abimbola Oyeniyi | abimbola.oyeniyi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 17/05/2022 |
| 141 | IMFB-KH-141 | Ifeoluwa Adewale | ifeoluwa.adewale@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 06/10/2019 |
| 142 | IMFB-KH-142 | Rosemary Eze | rosemary.eze@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 12/06/2018 |
| 143 | IMFB-KH-143 | Olamide Adeyemi | olamide.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 28/11/2022 |
| 144 | IMFB-KH-144 | Folorunso Adebayo | folorunso.adebayo@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 21/09/2020 |
| 145 | IMFB-KH-145 | Hameed Adebayo | hameed.adebayo@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 09/03/2017 |
| 146 | IMFB-KH-146 | Kelechi Nwosu | kelechi.nwosu@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 19/05/2023 |
| 147 | IMFB-KH-147 | Oreoluwa Adeyemi | oreoluwa.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 02/01/2021 |
| 148 | IMFB-KH-148 | Yemisi Adeola | yemisi.adeola@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 24/05/2019 |
| 149 | IMFB-KH-149 | Lawal Adeyemi | lawal.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 03/10/2022 |
| 150 | IMFB-KH-150 | Simisola Ogunleye | simisola.ogunleye@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 14/11/2020 |
| 151 | IMFB-KH-151 | Fatima Lawal | fatima.lawal@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 16/07/2018 |
| 152 | IMFB-KH-152 | Emeka Obiora | emeka.obiora@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 27/08/2022 |
| 153 | IMFB-KH-153 | Blessing Obiora | blessing.obiora@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 08/04/2021 |
| 154 | IMFB-KH-154 | Tope Adeyemi | tope.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 18/01/2023 |
| 155 | IMFB-KH-155 | Adeyinka Osho | adeyinka.osho@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 12/07/2017 |
| 156 | IMFB-KH-156 | Ngozi Ezeala | ngozi.ezeala@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 25/02/2020 |
| 157 | IMFB-KH-157 | Adeola Adesina | adeola.adesina@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 07/03/2023 |
| 158 | IMFB-KH-158 | Femi Ogunyemi | femi.ogunyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 20/11/2019 |
| 159 | IMFB-KH-159 | Olanrewaju Oluwole | olanrewaju.oluwole@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 09/05/2018 |
| 160 | IMFB-KH-160 | Amina Hamza | amina.hamza@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 29/01/2023 |
| 161 | IMFB-KH-161 | Chidimma Okafor | chidimma.okafor@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 13/06/2022 |
| 162 | IMFB-KH-162 | Adaeze Okafor | adaeze.okafor2@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 05/10/2019 |
| 163 | IMFB-KH-163 | Chukwudumebi Okafor | chukwudumebi.okafor@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 18/09/2022 |
| 164 | IMFB-KH-164 | Aina Ogunleye | aina.ogunleye@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 02/04/2020 |
| 165 | IMFB-KH-165 | Adamu Idris | adamu.idris@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 14/12/2022 |
| 166 | IMFB-KH-166 | Eucharia Okoro | eucharia.okoro@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 26/11/2018 |
| 167 | IMFB-KH-167 | Iyabo Akande | iyabo.akande@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 10/06/2019 |
| 168 | IMFB-KH-168 | Osezua Omoruyi | osezua.omoruyi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 23/04/2023 |
| 169 | IMFB-KH-169 | Paulette Adeyemi | paulette.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 15/07/2021 |
| 170 | IMFB-KH-170 | Lawrence Ekwueme | lawrence.ekwueme@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 29/05/2023 |
| 171 | IMFB-KH-171 | Chiamaka Amaechi | chiamaka.amaechi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 21/09/2021 |
| 172 | IMFB-KH-172 | Obiageli Nwosu | obiageli.nwosu@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 11/07/2022 |
| 173 | IMFB-KH-173 | Sunday Ogbonna | sunday.ogbonna@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 03/12/2020 |
| 174 | IMFB-KH-174 | Laila Adewale | laila.adewale@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 18/02/2022 |
| 175 | IMFB-KH-175 | Kehinde Adeyemi | kehinde.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 14/08/2017 |
| 176 | IMFB-KH-176 | Maimuna Adamu | maimuna.adamu@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 26/01/2023 |
| 177 | IMFB-KH-177 | Olugbenga Adewale | olugbenga.adewale@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 08/09/2019 |
| 178 | IMFB-KH-178 | Uzor Okechukwu | uzor.okechukwu@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 17/04/2018 |
| 179 | IMFB-KH-179 | Abike Adeyemi | abike.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 05/05/2023 |
| 180 | IMFB-KH-180 | Osaretin Okafor | osaretin.okafor@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 19/02/2019 |
| 181 | IMFB-KH-181 | Muritala Adeyemi | muritala.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 01/06/2022 |
| 182 | IMFB-KH-182 | Janet Okafor | janet.okafor@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 25/09/2022 |
| 183 | IMFB-KH-183 | Sikiru Adeyemi | sikiru.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 12/05/2020 |
| 184 | IMFB-KH-184 | Ngozi Okafor2 | ngozi.okafor2@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 28/01/2019 |
| 185 | IMFB-KH-185 | Ifeoma Eze | ifeoma.eze@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 20/07/2022 |
| 186 | IMFB-KH-186 | Bosede Adeyemi | bosede.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 06/11/2019 |
| 187 | IMFB-KH-187 | Yinka Adebayo | yinka.adebayo@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 16/06/2022 |
| 188 | IMFB-KH-188 | Adaeze Umeh | adaeze.umeh@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 10/04/2021 |
| 189 | IMFB-KH-189 | Chisom Eze | chisom.eze@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 22/10/2019 |
| 190 | IMFB-KH-190 | Rahmat Adeyemi | rahmat.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 05/08/2022 |
| 191 | IMFB-KH-191 | Okikiola Adeyemi | okikiola.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 15/03/2020 |
| 192 | IMFB-KH-192 | Osahon Oshodin | osahon.oshodin@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 09/02/2021 |
| 193 | IMFB-KH-193 | Damola Adesina | damola.adesina@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 30/04/2023 |
| 194 | IMFB-KH-194 | Funmilola Ojo | funmilola.ojo@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 13/06/2021 |
| 195 | IMFB-KH-195 | Adefunke Adeyemi | adefunke.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 27/08/2022 |
| 196 | IMFB-KH-196 | Ikechukwu Okafor | ikechukwu.okafor@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 07/11/2021 |
| 197 | IMFB-KH-197 | Bukola Ogunleye | bukola.ogunleye@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 19/03/2023 |
| 198 | IMFB-KH-198 | Chidinma Nwosu | chidinma.nwosu@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 02/04/2021 |
| 199 | IMFB-KH-199 | Olawale Adebayo | olawale.adebayo@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 12/10/2019 |
| 200 | IMFB-KH-200 | Yetunde Adeyemi | yetunde.adeyemi@infinitycorebank.com | LOAN OFFICER | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | CONFIRMED | 25/06/2020 |
| 201 | IMFB-KH-201 | Ogar Odey | ogar.odey@infinitycorebank.com | MANAGEMENT TRAINEE | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 10/04/2023 |
| 202 | IMFB-KH-202 | Rotimi Adeleke | rotimi.adeleke@infinitycorebank.com | MANAGEMENT TRAINEE | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 10/04/2023 |
| 203 | IMFB-KH-203 | Tomiwa Adeyemi | tomiwa.adeyemi@infinitycorebank.com | MANAGEMENT TRAINEE | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 10/04/2023 |
| 204 | IMFB-KH-204 | Zainab Adewale | zainab.adewale@infinitycorebank.com | MANAGEMENT TRAINEE | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 10/04/2023 |
| 205 | IMFB-KH-205 | Nnenna Ugwu | nnenna.ugwu@infinitycorebank.com | MANAGEMENT TRAINEE | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 10/04/2023 |
| 206 | IMFB-KH-206 | Chukwuemeka Nwafor | chukwuemeka.nwafor@infinitycorebank.com | MANAGEMENT TRAINEE | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 10/04/2023 |
| 207 | IMFB-KH-207 | Adaeze Ogbu | adaeze.ogbu@infinitycorebank.com | MANAGEMENT TRAINEE | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 10/04/2023 |
| 208 | IMFB-KH-208 | Balikis Alade | balikis.alade@infinitycorebank.com | MANAGEMENT TRAINEE | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 10/04/2023 |
| 209 | IMFB-KH-209 | Emeka Nwankwo | emeka.nwankwo@infinitycorebank.com | MANAGEMENT TRAINEE | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 10/04/2023 |
| 210 | IMFB-KH-210 | Ifeoma Okafor | ifeoma.okafor@infinitycorebank.com | MANAGEMENT TRAINEE | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 10/04/2023 |
| 211 | IMFB-KH-211 | Rukayat Adeyemi | rukayat.adeyemi@infinitycorebank.com | MANAGEMENT TRAINEE | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 10/04/2023 |
| 212 | IMFB-KH-212 | Abiodun Adewale | abiodun.adewale@infinitycorebank.com | MANAGEMENT TRAINEE | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 10/04/2023 |
| 213 | IMFB-KH-213 | Ndubuisi Eke | ndubuisi.eke@infinitycorebank.com | MANAGEMENT TRAINEE | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 10/04/2023 |
| 214 | IMFB-KH-214 | Onyeka Onyeka | onyeka.onyeka@infinitycorebank.com | MANAGEMENT TRAINEE | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 10/04/2023 |
| 215 | IMFB-KH-215 | Chiamaka Nwosu2 | chiamaka.nwosu2@infinitycorebank.com | MANAGEMENT TRAINEE | CREDIT & MARKETING | HEAD OFFICE - OSHODI | Yemi Adekoya | Ademola Olatunji | — | UNCONFIRMED | 10/04/2023 |

---

## 2. BRANCHES

32 distinct branch values used in the staff master data (preserve verbatim, including
combined strings and casing):

1. BARIGA/LAGOS Island 1
2. LAGOS ISLAND 2/IBEJU -LEKKI/AJAH
3. TRADE FAIR/BOUNDARY/ALABA
4. AGEGE & EGBEDA
5. MUSHIN/YABA
6. KETU & HEAD OFFICE
7. KOLA & ILE-EPO
8. OSHODI & IKEJA
9. HEAD OFFICE - OSHODI
10. LAGOS ISLAND2
11. KETU
12. IBEJU LEKKI
13. AJAH
14. BOUNDARY
15. ALABA
16. TRADE FAIR
17. BARIGA
18. LAGOS Island 1
19. YABA
20. MUSHIN
21. AGEGE
22. EGBEDA
23. KOLA
24. ILE-EPO
25. OSHODI
26. IKEJA
27. HEAD OFFICE
28. IKEJA & LEKKI
29. OSOLO/OKOTA
30. MILE 2/BADAGRY ROAD
31. FESTAC
32. AMUWO ODOFIN

Notes (data quality exceptions):
- "LAGOS ISLAND2" (no space) and "LAGOS ISLAND 2" (with space, appears within combined
  strings) are case/syntax variants — treat as distinct source values, do NOT merge silently.
- "BARIGA/LAGOS Island 1" contains mixed casing in "Island 1".
- Combined branches cover multiple physical branches — kept verbatim as single source value.

---

## 3. DESIGNATIONS

Distinct designations in the staff master data:

1. AREA MANAGER (AREA 1)
2. AREA MANAGER (AREA 2)
3. AREA MANAGER (AREA 3)
4. AREA MANAGER (AREA 5)
5. BRANCH MANAGER
6. LOAN OFFICER
7. SENIOR LOAN OFFICER
8. SME OFFICER
9. SENIOR SME OFFICER
10. MANAGEMENT TRAINEE
11. HEAD OF BUSINESS
12. HEAD OF OPERATIONS
13. HEAD, CONTACT CENTRE
14. HEAD, E-BANKING
15. HEAD OF DIGITAL BANKING
16. HEAD OF INTERNAL CONTROL
17. HEAD OF AUDIT
18. HEAD, RISK MANAGEMENT
19. HEAD OF COMPLIANCE
20. HEAD OF RECOVERY
21. HEAD, LOAN MONITORING & RECOVERY
22. HEAD OF LEGAL
23. HEAD OF INFORMATION TECHNOLOGY
24. HEAD, HUMAN RESOURCES
25. HEAD OF OTHER CREDIT UNITS
26. EXECUTIVE DIRECTOR
27. MD/CEO
28. CHIEF FINANCIAL OFFICER
29. FINANCIAL CONTROLLER
30. ADMIN MANAGER
31. ADMIN OFFICER
32. HR MANAGER
33. ICT OFFICER
34. LEGAL OFFICER
35. ACCOUNTANT
36. FINANCIAL ACCOUNTANT
37. MANAGEMENT ACCOUNTANT
38. BUDGET OFFICER
39. TREASURY OFFICER
40. INTERNAL AUDITOR
41. COMPLIANCE OFFICER
42. RISK ANALYST
43. CREDIT ANALYST
44. DATA ANALYST
45. BUSINESS ANALYST
46. CUSTOMER SERVICE OFFICER
47. RELATIONSHIP OFFICER
48. RECOVERY OFFICER
49. LOAN MONITORING OFFICER
50. SECURITY OFFICER
51. DRIVER
52. CLEANER
53. COURT PROCESS SERVER
54. FRONT DESK OFFICER
55. UNIT HEAD
56. HUB LEADER
57. TEAM LEAD
58. PEOPLE MANAGER
59. REGIONAL MANAGER
60. DEPUTY GENERAL MANAGER
61. GENERAL MANAGER
62. MANAGING DIRECTOR

Notes (data quality exceptions):
- AREA MANAGER designations reference AREA 1/2/3/5. No AREA 4 exists in source.
- These two lists overlap partially with jobs/careers designations used in recruitment;
  the employment master uses THIS list verbatim.

---

## 4. PERFORMANCE & COMPENSATION DEFAULTS (from induction slides)

Presentation: `INFINITY MFB INDUCTION SLIDES FOR FINCON.pptx`. These are the BANK
DEFAULTS — they must be seeded as "bank default" values and be editable by HR, with a
one-click "reset to bank defaults".

### 4.1 MPR COMPONENT WEIGHTS

| COMPONENT | WEIGHT (%) |
|-----------|-----------:|
| DISBURSEMENT | 35 |
| PAR | 35 |
| CASELOAD | 30 |
| **TOTAL** | **100** |

### 4.2 PAR SCORE BANDS (mapping to PAR component score)

| PAR RANGE | SCORE |
|-----------|------:|
| 0% – 4% | 35 |
| 4.1% – 5% | 30 |
| 5.1% – 6% | 20 |
| 6.1% – 7% | 15 |
| 7.1% – 10% | 7.5 |
| > 10% | 0 |

### 4.3 LOAN AGEING CLASSIFICATION

| CLASSIFICATION | DAYS |
|----------------|-----:|
| PERFORMING | 0 |
| PASS AND WATCH | 1 – 30 |
| SUBSTANDARD | 31 – 60 |
| DOUBTFUL | 61 – 90 |
| LOST | > 90 |

### 4.4 PERFORMANCE GRADES

| GRADE | SCORE RANGE | LETTER |
|-------|-------------|--------|
| EXCELLENT | 90 – 100 | A |
| VERY GOOD | 76 – 89 | B |
| GOOD | 65 – 75 | C |
| AVERAGE | 60 – 64 | D |
| UNSATISFACTORY | 50 Below | E |

SOURCE AMBIGUITY (flagged, no value invented): the "UNSATISFACTORY" band shows "50
Below". Whether this means "≤ 50" or "< 50" (i.e. does a score of exactly 50 belong to
AVERAGE or UNSATISFACTORY?) is unclear. Config is editable; default interpretation is
min = 0, max = 50 inclusive (i.e. ≤50) — recorded as a data-quality exception.

### 4.5 MOBILITY ALLOWANCE BANDS

| CATEGORY | LOAN PORTFOLIO SIZE (₦) | MONTHLY ALLOWANCE (₦) |
|----------|-------------------------|-----------------------:|
| LOAN OFFICER (1) | 0 – 5,099,999 | 10,000 |
| LOAN OFFICER (2) | 5,100,000 – 10,099,999 | 26,000 |
| LOAN OFFICER (3) | 10,100,000 – 15,099,999 | 30,000 |
| SENIOR LOAN OFFICER (1) | 15,100,000 – 19,999,999 | 35,000 |
| SENIOR LOAN OFFICER (2) | 20,000,000 – 29,999,999 | 37,000 |
| SENIOR SME OFFICER | 30,000,000 and above | 40,000 |

NOTE: category is DESIGNATION-based (SENIOR SME OFFICER etc.), not salary-derived.

### 4.6 PRODUCTIVITY BONUS

- **Eligible staff:** Loan Officers, SME Officers, Unit Heads.
- **Bonus frequency:** MONTHLY for Loan Officers / SME Officers / Unit Heads.
- **Bonus frequency:** QUARTERLY for Branch Managers, Area Managers, Hub Leaders,
  Head of Business.
- **Eligibility wait:** staff must be employed at least 4 months before eligibility.
- **Bonus scale:**
  - 60% of GROSS monthly salary when MPR achievement ≥ 75%.
  - 30% of GROSS monthly salary when MPR achievement 60% – 74%.

### 4.7 PRODUCTIVITY QUALIFICATION CRITERIA

To qualify for productivity bonus, ALL must hold:

1. MPR score between 60 and 75 points.
2. PAR ≤ 5% (new staff: PAR ≤ 3%).
3. 100% portfolio achievement.
4. SME PAR no more than 30 days.

### 4.8 PERFORMANCE SANCTIONS

| MONTH | MPR ACHIEVEMENT | SANCTION |
|-------|-----------------|----------|
| 1st | ≤ 40% | Warning Letter issued. |
| 2nd | ≤ 30% | Second Warning Letter + 20% bonus forfeiture. |
| 3rd | ≤ 30% | Final Warning Letter + 30% bonus forfeiture. |
| —    | Further | Staff is asked to resign. |

DISCRETION: sanctions are NEVER automatic — a human (HR/Management) reviews and
authorizes each sanction. All sanction events are audited.

### 4.9 REGULATORY REFERENCE VALUES

| METRIC | VALUE |
|--------|------:|
| CAR (Capital Adequacy Ratio) | 10% |
| LIQUIDITY RATIO | 20% |
| OPERATING EXPENSES / ASSETS | 15% |
| OPERATIONAL SELF-SUFFICIENCY (OSS) | 100% |
| ADJUSTED CAPITAL / NET CREDIT | 1 : 10 |
| FIXED ASSET / SHAREHOLDERS' FUNDS | 20% |
| PAR | 5% |
| SINGLE OBLIGOR LIMIT — INDIVIDUAL | 1% |
| SINGLE OBLIGOR LIMIT — CORPORATE | 5% |

---

## 5. IMPORT & MATCHING POLICY

- Matching order for each staff record on import: STAFF ID → existing auth user →
  normalized email → careful name match. Never duplicate an existing employee record.
- Staff onboarding data (InfinityCore) must be preserved; import only fills in gaps.
- Source of record is flagged per employee: "Bank Employee Master Imported" vs
  "InfinityCore Onboarding Completed".
- The 1ST/2ND/3RD SUPERVISOR columns become employee-to-employee relationships
  (level 1 = primary line manager). If a supervisor is not matched, the relationship
  goes into `hierarchy_exceptions` for manual resolution — never silently dropped.
- If a Branch Manager and Area Manager are the same person, do NOT link the branch to
  that area (relationship only exists between different persons).
- Area structure: Area Manager → multiple Branches → Branch Manager → staff.
- Branch/area assignments are auditable (previous/new assignment, changed by, timestamp,
  reason) and are never hard-deleted (superseded rows stay).

## 6. ACCOUNT INVITATION POLICY

- Button: "GENERATE EMPLOYEE ACCOUNT INVITATIONS" in User Management.
- Scope: single selection, multi-select, or "all eligible" (no auth account yet).
- Each row shows: name, staff ID, email, designation, department, branch, intended
  system role, account status.
- Server-side only — no passwords set by HR; the employee sets their own password via
  the secure Supabase invite link.
- Per-employee result: SUCCESS / ALREADY EXISTS / INVALID EMAIL / FAILED. Never fake
  a success — a failed invite is reported as FAILED.
- DESIGNATION is separate from SYSTEM ROLE. A safe role mapping is stored
  (`designation_role_mappings`) and every designation maps to the SAFEST role when no
  explicit mapping exists.
- HR Manager + super_admin may reassign privileges. HR Manager (and every non-super-admin)
  can never see or edit the super_admin role — not in dropdowns, not in lists.