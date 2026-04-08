(function() {
  var iconData = {
    'analytics': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAABOElEQVR4nO2Ty0oDQRBFb1U/CILRIMEhCC5U0IXrfIArt/5RNn5EfsWfEITssk0MCQoDPqane66LJLs8wBBEmLMsuu6huruAmpo/g6SQlH8TLCSVpC4L0+n0Mc/zh4XUrGu0m1Jns1kzxtjNsuxJRAgAk8nk0jnXTSkNiqIYLI5WvxI451wk26PRqN1oNG5IdgDkIYRXa+1ZSulkOSEArsrQVcUlnFOq6oWqfgN4jzEmETlOKT2LSGdT/1YBAEpVWQBSFIUF0FTVAsCtiHxVVRV3EozH42iM6aSUmiRPK6DlvX8hGVT1U1XLnQTGmACgZYw5F5FMyKsQwr21tpNSuiN5TdJizf0D88fZyHA4PDo05uCDpPc+OudcCCF4731ZlmW/33/r9Xprf9He2TrBtq1d7kdNzf74Aax0m4DUmnLhAAAAAElFTkSuQmCC',
    'canned-responses': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAABBUlEQVR4nO2TMU7DQBBF/59YliIMRIkLu0MUiFvQcQru4lyAq1BxB24RpFC4sERhgeJl1/40iUQBNgHSIL9qtTP6b0ejBUZGfgu/0ySJu16S3Z8LPhHa7khSPxZIIklVVXVM8trM3Hw+v9/nMdFAnQA0mUyu2rZ9NrO0LMuzJEmOnHOKoqiZzWarvgDrqZFkV9d1KskDqEMIiZmdNk2TSco2m006NMGXgqIoCADOuYWki7ZtPYAT7729bdne9TK0AyPZVVV1Q/Lce38r6TKO4wUAhRBesix76Mvo3cFyuQQAmFkG4C7P89f1ev1I8gkA/HQahibYi+1/OAwfwyXxoLKRkX/GO2J6eZ0D+IecAAAAAElFTkSuQmCC',
    'conversations': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAABZklEQVR4nO2TwUrDQBCGZza7NiLSQDeGUASPQpGeBBE8eha8+Qz6Dn0PX0WEiuKpXr0E6cHQkia0ASmhSXbHi4GiaalWxEO+4+zu9w/DDkBFxZ9BREhEWFJn60rZvOS7wi8dLWI4HG5xzk8BQBFjm0qlyJEbiBg2Go1bACBEpJUCiAgRkUajkYuIh4yxTGt9gIgJET1LKR8AQHe7Xdpvtc4FY49SSr94t1KA53kb9Xr9olar3ed5PlNK5VprLYRoE1EmpbxDQBiEgxNU+Oq6br8sgJcFICKNx2MzSZLYcZyX+bM4jp+SJDkuREZg2JnK+otGWxoAABAEgbYsy/xcn06nzDTNoyiKZkTkKIC3ZrM5KOseYMmIPkLOhBBJlmUe57xNRDkR7XDOb9I0tQzDOLJt+3qRfCnFd4yi6CoMw8vJZLLn+/5uGIbb8/c6nc7P9wAAoNfriZJwLHZkLXmZ9NeEFRX/h3ep38k6ZeAn6QAAAABJRU5ErkJggg==',
    'dashboard': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAABWUlEQVR4nO2UTUoDQRCF32tnwphEzIxmIIiguHMh4hHE+7j0Gt7EiGvxBOomXkAIHUKkZYRJ4qS63BgIEjPBn12+VRfUe11VTTWwYsW/o6qcPX+Ny/RBWQJJtdbWoigKSb4CgHOukef5O8m8VL+gckPS93q9o0qlckwyU1UVEQZBABHZLIrivtVqdaa583xMWQVrlbV959x1HMdtklskG3Ect/M8v2HAgzJ9+Yg8h/V6fa+bZV2IQETYzbLtUGTXiAx/c4ECwHg8fqhWq+eh95H3/ioMQxN6f6HAaDgaXc7mzi3wW/fPuQ4GgzMAb8YYS/JURNQYc6eqO977arPZvP3VGxhjakVRdJIkeQZgRIRJkjy/6MsTgI0yfWkH/X7/JAiCQwCvqroOACSHAOLJZNJJ0/RxUQdL4ZxrWGvTaWytTZ1zjR8bzrJoW5fZ5GWZ90X8mfmKFYv5ACcLtaGFjYXMAAAAAElFTkSuQmCC',
    'mailboxes': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAABi0lEQVR4nO2SsU4bQRCGZ2Z377AWgTgsJfSpsOAJoKGjoqfzM6Q00kpI4RXyDi7zArEUpUA0dDRQ2DJen886CyQjb3S7k8aRHCleLEQTyV/7z/zzz2gA1qxZhJmRmfHdjY0xxMy0MIiMMRTrWZnFxKPRaC/P84//0pYRTWGMIURka22jLMtzIvpMRK3JZNIcDAb7iMivbSJjyREx9Pv9XZkkp865H0RUOufulVLPSqlmWZaPWZY9zWt55Q3+rJ7n+ebGRu0SQnjx3hMRHaZpegQAU+/9rxDCF2utXuxZaQAAACKyc27b++oGhECttQOAr865byzlfpIkrqqqWyHE1rL00RMBAEgpZQjh7kOWXY/H4wsietFaIzOnWZZddbvdYykrFfWIid57r5T6NBwO95j5Z71e/w4AUBTFSVEUZyGE7dls9hDzWPpmzIydTkc0Dg5azDwNVXUHAHouT0nKhhAi3d3ZuQKAEDvTqzC3hbVW97hXY+7VrLW63W6LNxv+bc5LHyGmrVnzH/EbuPbHAme6hF4AAAAASUVORK5CYII=',
    'settings': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAABdElEQVR4nO2TzUojQRSF76lbCUQQV0KkiTuRIIgoqIgzunHpM/Ub+BTOpnfiSp8h4A/ZiJJFfjqLMGEWkzBNquq4ScDFdKv4s8q3K6rqnHPvrRKZM+clcRybOI7NpwuTNEmS6GydJImS/HyjwWCwnqZp/T13ULRJEiKCXq+3aa3d8N4HVYWqmizLmlEU3YsIATBPo7BMAGy1WosAjkg+GmPuQwi3k8nkAcCPdru9NBXPDZprME0vpVJpHUAvY/Y3hLBljNkGMAaQqmp9ejY3ZGEFjUajZK09WUnTi7KUf0ZR9KtarZ4H4GA4HF6q6g5JW9iF1yrodrvH1toF7/2Tqh4SzPzE/1bVZRGpOefOarXav7w5vDoD59xNCGGtUqmMnXNXIK5FZZXkEklnjFkFwLxnm2swvYTRaDQOIdw5505VddeLP0LAH1U1APqq2iUJAKEo7Jvo9/t7nU5nX0Sk2WyWPyw4g6R52YIv+cX/M5oz53t4BmUAuPVL5chHAAAAAElFTkSuQmCC',
    'sla-timer': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAABb0lEQVR4nO2TvWobQRSFz50xIpa0CVgLXqPKeoRAiIsUIuQBksbv5gdwI2H8BoZUaVK6MW5UeIvVjrWSIrMsO3uPq4VgtFpMfip91Qznzrk/MwPs2fNfICkkpWn/x+b1Ok3TgGR/m9bEzgCSIiLcbDZRURRjAAFJFZGnTqdzEwTBvI5p8jhoq8CRb4vF6mtZltd5nq+CIOiUZXkIa78lSXIJ4GnXedMkTCYTKyLE4+NZQf/de+97vd6X2WyWR1GUiOoPY8wHESHJRp/WDlT1nVHtngyHd865fDQanS8Wi1+qeiQiMQBMp9PGUTcKJI2IaJpln43qfDAY3NZalmXvSX6sqkrCMLwAQBHRbT6NrYmIkhSpqp8APiVJEsVxHDrnht77s6qqHowxfefccR27zad1RGEYrtfr9RWAsbW2D0ABeGvtqare53metb2knfxeWRzHXZJvAGC5XB7tutxXJ3n5k/+KcVvSf55kzx4AwDPP9dFjny36+gAAAABJRU5ErkJggg==',
    'tags': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAABD0lEQVR4nO2TvUoDURCFz+xGF7UKplEIKS3sRSx8AG0sgwhGXyRPY5PCJ3G7VLdME7J37ly2sFrwWGhgEXU1UbTYr545c+YPaGl5C0khKX/t43vUHXvv98uy3P1qbmOrJEVESHJDow470nmsqmogItrr9e4AUET4UX7S6ECE0+l008xu5Ekeut3ufZqmfZL9PM/Tz8QbGY/HiXMuU9XbEMIhADjnstlstuW9v5zP5zsri08mkxQAihDOVPUIAEhmAKCqxz7Gi9eLapzCuyzP0cwGMcYRyW0AMLNTb3a1jFm5g7qAL/2Bql6b2XkIYQi8jG8t8VqRBACKothbLBYn9cI/Rl3w1754rYW2tPxvngF9U5330GrQ1QAAAABJRU5ErkJggg==',
    'routing-rules': "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='16 3 21 3 21 8'/%3E%3Cline x1='4' y1='20' x2='21' y2='3'/%3E%3Cpolyline points='21 16 21 21 16 21'/%3E%3Cline x1='15' y1='15' x2='21' y2='21'/%3E%3Cline x1='4' y1='4' x2='9' y2='9'/%3E%3C/svg%3E",
    'load-balancing': "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cline x1='12' y1='2' x2='12' y2='6'/%3E%3Cline x1='4' y1='10' x2='20' y2='10'/%3E%3Cpolygon points='12 6 4 10 20 10'/%3E%3Cline x1='7' y1='10' x2='7' y2='16'/%3E%3Cline x1='17' y1='10' x2='17' y2='16'/%3E%3Crect x='4' y='16' width='6' height='4' rx='1'/%3E%3Crect x='14' y='16' width='6' height='4' rx='1'/%3E%3C/svg%3E",
    'csat-surveys': "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='white' stroke='white' stroke-width='1'%3E%3Cpolygon points='12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26'/%3E%3C/svg%3E",
    'knowledge-base': "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 19.5A2.5 2.5 0 0 1 6.5 17H20'/%3E%3Cpath d='M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'/%3E%3Cline x1='8' y1='7' x2='16' y2='7'/%3E%3Cline x1='8' y1='11' x2='14' y2='11'/%3E%3C/svg%3E",
    'leaderboard': "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M8 21h8M12 17v4M6 3h12l-1.5 6.5a5 5 0 0 1-9 0L6 3z'/%3E%3Cpath d='M6 3C4.5 3 3 4 3 6s1.5 3 3 3'/%3E%3Cpath d='M18 3c1.5 0 3 1 3 3s-1.5 3-3 3'/%3E%3C/svg%3E",
    'manager-dashboard': "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'/%3E%3Ccircle cx='9' cy='7' r='4'/%3E%3Cpath d='M23 21v-2a4 4 0 0 0-3-3.87'/%3E%3Cpath d='M16 3.13a4 4 0 0 1 0 7.75'/%3E%3C/svg%3E",
    'performance': "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cline x1='18' y1='20' x2='18' y2='10'/%3E%3Cline x1='12' y1='20' x2='12' y2='4'/%3E%3Cline x1='6' y1='20' x2='6' y2='14'/%3E%3C/svg%3E",
    'ai-summaries': "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='18' height='18' rx='3'/%3E%3Ccircle cx='9' cy='10' r='1.5' fill='white'/%3E%3Ccircle cx='15' cy='10' r='1.5' fill='white'/%3E%3Cpath d='M9 15c.8 1.2 2.2 2 3 2s2.2-.8 3-2'/%3E%3C/svg%3E",
    'omnichannel': "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cline x1='2' y1='12' x2='22' y2='12'/%3E%3Cpath d='M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'/%3E%3C/svg%3E"
  };
  var menuIconMap = {
    'Dashboard': 'dashboard',
    'Conversations': 'conversations',
    'Mailboxes': 'mailboxes',
    'Tags': 'tags',
    'Canned Responses': 'canned-responses',
    'SLA Tracking': 'sla-timer',
    'Response Analytics': 'analytics',
    'Settings': 'settings',
    'Routing Rules': 'routing-rules',
    'Load Balancing': 'load-balancing',
    'CSAT Surveys': 'csat-surveys',
    'Knowledge Base': 'knowledge-base',
    'Leaderboard': 'leaderboard',
    'Manager Dashboard': 'manager-dashboard',
    'Performance': 'performance',
    'AI Summaries': 'ai-summaries',
    'Omnichannel': 'omnichannel'
  };
  function applyIcons() {
    var links = document.querySelectorAll('.sidebar a');
    links.forEach(function(link) {
      var iconDiv = link.querySelector('.icon') || link.querySelector('div');
      var labelSpan = link.querySelector('span');
      if (iconDiv && labelSpan) {
        var label = labelSpan.textContent.trim();
        var iconName = menuIconMap[label];
        if (iconName && iconData[iconName]) {
          var img = document.createElement('img');
          img.src = iconData[iconName];
          img.alt = label;
          var isSvg = iconData[iconName].indexOf('svg') !== -1;
          if (isSvg) {
            img.style.cssText = 'width:28px;height:28px;vertical-align:middle;opacity:0.9;';
          } else {
            img.style.cssText = 'width:28px;height:28px;vertical-align:middle;filter:brightness(0) invert(1);opacity:0.9;';
          }
          iconDiv.textContent = '';
          iconDiv.appendChild(img);
        }
      }
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(applyIcons, 500); });
  } else {
    setTimeout(applyIcons, 500);
  }
  var oer:Switch = window.switchView;
  if (oer:Switch) {
    window.switchView = function(v) { oer:Switch(v); setTimeout(applyIcons, 100); };
  }
})();
