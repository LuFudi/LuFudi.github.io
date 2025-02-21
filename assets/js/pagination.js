document.addEventListener('DOMContentLoaded', function () {
    const totalPages = parseInt(document.getElementById('total_pages').value, 10);
    const currentPage = parseInt(document.getElementById('current_pages').value, 10);
    const baseUrl = document.getElementById('base_url').value;
    const pageLinkContainer = document.getElementById('page-link-container');

    if (pageLinkContainer) {
        let pageLinks = '';

        for (let i = 1; i <= totalPages; i++) {
            if (i === currentPage) {
                pageLinks += `<span class="page-link current">${i}</span>`;
            } else {
                pageLinks += `<a href="${baseUrl}${i}" class="page-link">${i}</a>`;
            }
        }

        pageLinkContainer.innerHTML = pageLinks;
    }
});